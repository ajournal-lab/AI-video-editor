import "server-only";
// "Render in cloud" on GitHub Actions. OFF unless Settings → Render in cloud is enabled, and every run needs the user's
// click + confirmation: /prepare builds the bundle locally (nothing leaves the machine) and returns a one-time token
// shown in the confirmation dialog; /start only runs with that token. The upload + Actions run + download + cleanup
// happen in agent/cloud-render.ts, as a local-command job on the agent runner (same queue, log and cancel).
import crypto from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CloudRender, Project } from "@prisma/client";
import { appDir, storageDir } from "@/agent/config";
import { actionsMinutes, cloudToken, gh, verifyPrivateRepo } from "@/agent/github";
import type { Timeline } from "@/lib/timeline/types";
import { createJob, jobDTO, localMediaPath } from "./agent";
import { prisma } from "./db";
import { HttpError } from "./http";
import { renderGate } from "./pipeline";
import { renderVersion } from "./renders";
import { getSettings } from "./settings";

const ENGINE_FILES = ["render.py", "color.py", "enhance.py", "grade.py", "ass.py", "audio_master.py", "quality.py", "media.py", "timeline.py", "cloud_entry.py"];
const MAX_FILE = 95 * 1024 * 1024; // GitHub's blob API refuses files over 100 MB
const MAX_TOTAL = 900 * 1024 * 1024;
const TOKEN_TTL_MS = 15 * 60_000;

export const cloudDir = (id: string) => path.join(storageDir(), "cloud", id);
export const branchFor = (id: string) => `reelsmith-render/${id}`;

export function workflowYaml(quality: string) {
  return `# Added by ReelSmith "Render in cloud" on a temporary branch; deleted with the branch after the video is downloaded.
name: ReelSmith render
on:
  push:
    branches: ["reelsmith-render/**"]
permissions:
  contents: read
jobs:
  render:
    runs-on: ubuntu-24.04
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - name: Install ffmpeg and Python packages
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y -qq ffmpeg
          python3 -m pip install --quiet --break-system-packages numpy requests
      - name: Render
        run: python3 reelsmith/cloud_entry.py --bundle . --quality ${quality} --out out
      - uses: actions/upload-artifact@v4
        with:
          name: reelsmith-render
          path: out/
          retention-days: 1
          if-no-files-found: error
`;
}

/** Copy the timeline's media into the bundle and point the timeline at the copies (only the fields the engine reads). */
function bundleTimeline(tl: Timeline, mediaDir: string) {
  const copied = new Map<string, string>();
  const walk = (v: unknown, key?: string): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    if (typeof v === "string" && (key === "src" || key === "url")) {
      const p = localMediaPath(v);
      if (!p) return v;
      let rel = copied.get(p);
      if (!rel) {
        const name = `${crypto.createHash("sha1").update(p).digest("hex").slice(0, 12)}${path.extname(p).toLowerCase()}`;
        copyFileSync(p, path.join(mediaDir, name));
        rel = `media/${name}`;
        copied.set(p, rel);
      }
      return rel;
    }
    return v;
  };
  return walk(tl) as Timeline;
}

/** Everything the Actions runner needs, in `dir`: timeline, media, engine, fonts, workflow. Local only. */
export function buildBundle(timeline: Timeline, dir: string, quality: string, title: string) {
  for (const sub of ["media", "fonts", "reelsmith", ".github/workflows"]) mkdirSync(path.join(dir, sub), { recursive: true });
  writeFileSync(path.join(dir, "timeline.json"), JSON.stringify(bundleTimeline(timeline, path.join(dir, "media"))));
  for (const f of ENGINE_FILES) copyFileSync(path.join(appDir(), "worker", f), path.join(dir, "reelsmith", f));
  const fonts = path.join(appDir(), "public", "fonts");
  if (existsSync(fonts)) for (const f of readdirSync(fonts)) if (statSync(path.join(fonts, f)).isFile()) copyFileSync(path.join(fonts, f), path.join(dir, "fonts", f));
  writeFileSync(path.join(dir, ".github", "workflows", "reelsmith-render.yml"), workflowYaml(quality));
  writeFileSync(path.join(dir, "README.md"), `ReelSmith cloud render bundle (${title}). Temporary: deleted after the render unless you chose to keep it.\n`);
  return listFiles(dir);
}

function listFiles(dir: string, base = dir): { rel: string; abs: string; bytes: number }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const abs = path.join(dir, d.name);
    return d.isDirectory() ? listFiles(abs, base) : [{ rel: path.relative(base, abs).replace(/\\/g, "/"), abs, bytes: statSync(abs).size }];
  });
}

async function cloudSettings(userId: string) {
  const s = await getSettings(userId);
  if (!s.cloud.enabled) throw new HttpError(403, "Render in cloud is switched off. Turn it on in Settings first.");
  if (!cloudToken()) throw new HttpError(400, "Add CLOUD_RENDER_TOKEN to .env (see Settings)");
  if (!s.cloud.repo) throw new HttpError(400, "Set the private render repo in Settings");
  return s.cloud;
}

/** Step 1 (local only): snapshot the timeline, build the bundle, check the repo is private, return what will be uploaded. */
export async function prepareCloud(project: Project, userId: string, o: { quality: "720p" | "1080p"; json?: unknown; keep?: boolean }) {
  const cfg = await cloudSettings(userId);
  const tlNow = (o.json as Timeline | undefined) ?? null;
  const gate = renderGate(project, tlNow);
  if (!gate.ok) throw new HttpError(409, gate.reason);
  let repo;
  try {
    repo = await verifyPrivateRepo(cfg.repo);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const { version, timeline } = await renderVersion(project, o.json);
  const row = await prisma.cloudRender.create({
    data: { projectId: project.id, userId, versionId: version.id, quality: o.quality, repo: repo.full_name, branch: "", keep: o.keep ?? cfg.keep, status: "preparing" },
  });
  const dir = path.join(cloudDir(row.id), "bundle");
  try {
    buildBundle(timeline, dir, o.quality, project.title);
  } catch (e) {
    rmSync(cloudDir(row.id), { recursive: true, force: true });
    await prisma.cloudRender.update({ where: { id: row.id }, data: { status: "failed", error: (e as Error).message } });
    throw new HttpError(500, `Could not build the bundle: ${(e as Error).message}`);
  }
  const files = listFiles(dir);
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const tooBig = files.filter((f) => f.bytes > MAX_FILE);
  if (tooBig.length || total > MAX_TOTAL) {
    rmSync(cloudDir(row.id), { recursive: true, force: true });
    await prisma.cloudRender.update({ where: { id: row.id }, data: { status: "failed", error: "Bundle too large" } });
    throw new HttpError(400, tooBig.length ? `${tooBig.map((f) => f.rel).join(", ")} is over 95 MB (GitHub's limit per file). Render locally instead.` : "The bundle is over 900 MB. Render locally instead.");
  }
  const token = crypto.randomBytes(24).toString("hex");
  const minutes = await actionsMinutes(repo.owner.login, repo.owner.type).catch(() => null);
  await prisma.cloudRender.update({
    where: { id: row.id },
    data: { status: "prepared", branch: branchFor(row.id), bundleDir: dir, bundleBytes: total, minutes: minutes ?? undefined, confirmHash: crypto.createHash("sha256").update(token).digest("hex") },
  });
  return {
    cloudId: row.id,
    token,
    repo: { name: repo.full_name, private: repo.private, url: repo.html_url },
    branch: branchFor(row.id),
    keep: o.keep ?? cfg.keep,
    totalBytes: total,
    media: files.filter((f) => f.rel.startsWith("media/")).map((f) => ({ name: f.rel, bytes: f.bytes })),
    fileCount: files.length,
    minutes,
    changedSinceStills: gate.changed,
  };
}

/** Step 2: the user confirmed in the dialog. Re-checks everything, then queues the upload/render job. */
export async function startCloud(project: Project, userId: string, cloudId: string, token: string, keep?: boolean) {
  const cfg = await cloudSettings(userId);
  const row = await prisma.cloudRender.findFirst({ where: { id: cloudId, projectId: project.id, userId } });
  if (!row || row.status !== "prepared") throw new HttpError(404, "Prepare the cloud render again");
  const ok = row.confirmHash && crypto.timingSafeEqual(Buffer.from(row.confirmHash), Buffer.from(crypto.createHash("sha256").update(token).digest("hex")));
  if (!ok) throw new HttpError(403, "This upload wasn't confirmed");
  if (Date.now() - row.createdAt.getTime() > TOKEN_TTL_MS) throw new HttpError(410, "The confirmation expired: prepare it again");
  if (row.repo !== cfg.repo) throw new HttpError(409, "The render repo changed in Settings: prepare it again");
  try {
    await verifyPrivateRepo(row.repo);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const tsx = path.join(appDir(), "node_modules", "tsx", "dist", "cli.mjs");
  const job = await createJob({
    userId,
    projectId: project.id,
    kind: "cloud_render",
    title: `Cloud render ${row.quality} (${row.repo})`,
    prompt: "(local command)",
    exec: [process.execPath, tsx, path.join(appDir(), "agent", "cloud-render.ts"), row.id],
    timeoutSec: 90 * 60,
  });
  await prisma.cloudRender.update({ where: { id: row.id }, data: { status: "queued", step: "Waiting for the agent runner", agentJobId: job.id, confirmHash: null, keep: keep ?? row.keep } });
  return { job: jobDTO(job) };
}

export function cloudDTO(r: CloudRender) {
  return {
    id: r.id,
    status: r.status,
    step: r.step,
    progress: r.progress,
    repo: r.repo,
    branch: r.branch,
    keep: r.keep,
    runUrl: r.runUrl,
    bundleBytes: r.bundleBytes,
    minutes: r.minutes as { used: number; included: number | null; remaining: number | null } | null,
    renderJobId: r.renderJobId,
    agentJobId: r.agentJobId,
    cleanedUp: r.cleanedUp,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

/** Delete what a cloud render left on GitHub (branch, run + logs, artifact). Used after cancel or a crash. */
export async function cleanupCloud(row: CloudRender) {
  const done: string[] = [];
  const errors: string[] = [];
  const tryIt = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      done.push(label);
    } catch (e) {
      if (!/ 404:/.test((e as Error).message)) errors.push(`${label}: ${(e as Error).message}`);
    }
  };
  if (row.artifactId) await tryIt("artifact", () => gh(`/repos/${row.repo}/actions/artifacts/${row.artifactId}`, { method: "DELETE" }));
  if (row.runId) await tryIt("workflow run", () => gh(`/repos/${row.repo}/actions/runs/${row.runId}`, { method: "DELETE" }));
  if (row.branch) await tryIt("branch", () => gh(`/repos/${row.repo}/git/refs/heads/${row.branch}`, { method: "DELETE" }));
  rmSync(cloudDir(row.id), { recursive: true, force: true });
  await prisma.cloudRender.update({ where: { id: row.id }, data: { cleanedUp: errors.length === 0, error: errors.length ? errors.join("; ").slice(0, 2000) : row.error } });
  return { done, errors };
}
