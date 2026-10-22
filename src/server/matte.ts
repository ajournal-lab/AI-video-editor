import "server-only";
// Background swap: worker/matte.py cuts the person out of a source window (Robust Video Matting, CPU) into a matte
// video; clips that use that source get clip.matte and the tracks below (a background image) show through.
// The matte runs as a local command job on the agent runner (same queue, log and cancel as the AI upscale).
// settleMattes() turns finished jobs on when the timeline is loaded, so a matte queued on plan approval switches on
// even if the editor wasn't open.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { matteScript, workerPython } from "@/agent/config";
import { matteWindows } from "@/lib/timeline/matte";
import type { Timeline, VisualClip } from "@/lib/timeline/types";
import { createJob, localMediaPath } from "./agent";
import { prisma } from "./db";
import { HttpError } from "./http";
import { driver, localPath, publicUrl, storageDir } from "./storage";

export interface MatteEstimate {
  frames: number;
  fps: number;
  width: number;
  height: number;
  secPerFrame: number;
  seconds: number;
}

function runMatte(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(workerPython(), [matteScript(), ...args], { env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, windowsHide: true });
    let out = "";
    let err = "";
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(t);
      reject(new Error(`Could not run ${workerPython()}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new HttpError(500, (err.trim().split(/\r?\n/).slice(-2).join(" ") || `matte.py exited with ${code}`).slice(0, 500)));
    });
  });
}

function sourceFile(userId: string, src: string) {
  if (driver() !== "local") throw new HttpError(400, "Background removal needs local storage");
  if (src.includes("/api/files/u/") && !src.includes(`/api/files/u/${userId}/`)) throw new HttpError(403, "Not your file");
  const file = localMediaPath(src);
  if (!file || !existsSync(file)) throw new HttpError(404, "Only local media can be cut out");
  return file;
}

export async function estimateMatte(userId: string, src: string, srcIn: number, srcLen: number): Promise<MatteEstimate> {
  const out = await runMatte(["estimate", "--src", sourceFile(userId, src), "--in", String(srcIn), "--len", String(srcLen)], 5 * 60_000);
  return JSON.parse(out.trim().split(/\r?\n/).pop()!);
}

/** Queue one matte job for a source window; the clips get matte {on: false, jobId} until it is done. */
export async function queueMatte(userId: string, projectId: string, src: string, srcIn: number, srcLen: number, name: string) {
  const file = sourceFile(userId, src);
  // the same window already cut out (or being cut out): reuse it. Looks re-apply often and must never queue twice.
  const prev = await prisma.agentJob.findMany({
    where: { userId, kind: "matte", status: { in: ["queued", "running", "done"] } },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, status: true, exec: true },
  });
  for (const j of prev) {
    const a = JSON.parse(j.exec ?? "[]") as string[];
    const at = (k: string) => a[a.indexOf(k) + 1];
    const out = at("--out");
    const pIn = Number(at("--in"));
    const pLen = Number(at("--len"));
    // any earlier cut-out that covers this source window will do (the clips read it at their own offset)
    if (at("--src") !== file || !out || pIn > srcIn + 0.001 || pIn + pLen < srcIn + srcLen - 0.001) continue;
    if (j.status === "done" && !existsSync(out)) continue;
    const key = path.relative(storageDir(), out).split(path.sep).join("/");
    return { job: (await prisma.agentJob.findUnique({ where: { id: j.id } }))!, url: publicUrl(key), srcIn: pIn, srcLen: pLen };
  }
  const key = `u/${userId}/matte/${projectId}/${crypto.randomBytes(6).toString("hex")}-matte.webm`;
  const job = await createJob({
    userId,
    projectId,
    kind: "matte",
    title: `Cut out the person: ${name.slice(0, 40)} (${srcLen.toFixed(1)}s)`,
    prompt: "(local command)",
    exec: [workerPython(), matteScript(), "run", "--src", file, "--in", String(srcIn), "--len", String(srcLen), "--out", localPath(key)],
    timeoutSec: 6 * 60 * 60,
  });
  return { job, url: publicUrl(key), srcIn, srcLen };
}

/** Queue mattes for these clips (mutates them: matte = {on: false, jobId}). */
export async function queueMattesFor(userId: string, projectId: string, clips: VisualClip[]) {
  const jobs = [];
  for (const w of matteWindows(clips)) {
    const q = await queueMatte(userId, projectId, w.src, w.srcIn, w.srcLen, w.name);
    for (const c of clips) if (c.src === w.src) c.matte = { on: false, url: q.url, srcIn: q.srcIn, srcLen: q.srcLen, fps: 0, jobId: q.job.id };
    jobs.push(q.job.id);
  }
  return jobs;
}

/** Finished matte jobs -> matte on; failed ones -> dropped. Returns the timeline and whether it changed. */
export async function settleMattes(projectId: string, tl: Timeline) {
  const pending = tl.tracks.flatMap((t) => (t.kind === "video" ? t.clips.filter((c) => c.matte?.jobId) : []));
  if (!pending.length) return { tl, changed: false };
  const jobs = await prisma.agentJob.findMany({ where: { id: { in: [...new Set(pending.map((c) => c.matte!.jobId!))] } }, select: { id: true, status: true } });
  const status = new Map(jobs.map((j) => [j.id, j.status]));
  let changed = false;
  for (const c of pending) {
    const s = status.get(c.matte!.jobId!);
    if (s === "done") {
      const file = localMediaPath(c.matte!.url);
      c.matte = file && existsSync(file) ? { ...c.matte!, on: true, jobId: null } : null;
      changed = true;
    } else if (!s || s === "failed" || s === "cancelled") {
      c.matte = null;
      changed = true;
    }
  }
  if (changed) {
    await prisma.timeline.update({ where: { projectId }, data: { json: tl as unknown as Prisma.InputJsonValue, revision: { increment: 1 } } });
  }
  return { tl, changed };
}
