/**
 * "Render in cloud" worker step (run by the agent runner as a local-command job, never on its own):
 *
 *   tsx agent/cloud-render.ts <cloudRenderId>
 *
 * 1. re-checks the repo is PRIVATE, uploads the prepared bundle as one commit on a new branch reelsmith-render/<id>
 *    (Git Data API: blobs -> tree -> parentless commit -> ref; the branch's own workflow file triggers on that push)
 * 2. follows the Actions run (status, steps), 3. downloads the artifact (video + thumbnail + quality report) into
 * the project as a normal export, 4. deletes the branch, the run (with its logs) and the artifact unless "keep" was
 * chosen, and the local bundle. The prepare/confirm steps that must come first live in src/server/cloud.ts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient, type CloudRender, type Prisma } from "@prisma/client";
import { actionsMinutes, gh, verifyPrivateRepo } from "../src/agent/github";
import { readZip } from "../src/agent/zip";
import { storageDir } from "../src/agent/config";

loadEnv();
const prisma = new PrismaClient();
const id = process.argv[2];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadEnv() {
  const env = path.resolve(__dirname, "..", ".env");
  if (!existsSync(env)) return;
  for (const raw of readFileSync(env, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    if (process.env[k] === undefined) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}

const log = (s: string) => console.log(s);

async function update(data: Prisma.CloudRenderUpdateInput) {
  return prisma.cloudRender.update({ where: { id }, data });
}

function files(dir: string, base = dir): { rel: string; abs: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const abs = path.join(dir, d.name);
    return d.isDirectory() ? files(abs, base) : [{ rel: path.relative(base, abs).replace(/\\/g, "/"), abs }];
  });
}

async function upload(row: CloudRender) {
  const list = files(row.bundleDir!);
  const tree: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
  let done = 0;
  const queue = [...list];
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const content = readFileSync(f.abs).toString("base64");
      const blob = await gh<{ sha: string }>(`/repos/${row.repo}/git/blobs`, { method: "POST", json: { content, encoding: "base64" }, signal: AbortSignal.timeout(15 * 60_000) });
      tree.push({ path: f.rel, mode: "100644", type: "blob", sha: blob.sha });
      done++;
      await update({ progress: 0.05 + 0.25 * (done / list.length), step: `Uploading ${done}/${list.length} files` });
      log(`  uploaded ${f.rel} (${(statSync(f.abs).size / 1e6).toFixed(1)} MB)`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const t = await gh<{ sha: string }>(`/repos/${row.repo}/git/trees`, { method: "POST", json: { tree } });
  const c = await gh<{ sha: string }>(`/repos/${row.repo}/git/commits`, { method: "POST", json: { message: `ReelSmith cloud render ${row.id} (temporary)`, tree: t.sha, parents: [] } });
  await gh(`/repos/${row.repo}/git/refs`, { method: "POST", json: { ref: `refs/heads/${row.branch}`, sha: c.sha } });
  log(`Pushed ${list.length} files to ${row.repo} branch ${row.branch}`);
  return c.sha;
}

type Run = { id: number; status: string; conclusion: string | null; html_url: string; head_sha: string };

async function waitForRun(row: CloudRender, sha: string): Promise<Run> {
  const t0 = Date.now();
  while (Date.now() - t0 < 4 * 60_000) {
    const r = await gh<{ workflow_runs: Run[] }>(`/repos/${row.repo}/actions/runs?branch=${encodeURIComponent(row.branch)}&per_page=5`);
    const run = r.workflow_runs.find((x) => x.head_sha === sha);
    if (run) return run;
    await sleep(5000);
  }
  throw new Error("No Actions run started within 4 minutes. Is GitHub Actions enabled for this repo, and does the token have the Workflows permission?");
}

async function follow(row: CloudRender, run: Run): Promise<Run> {
  let last = "";
  for (;;) {
    const r = await gh<Run>(`/repos/${row.repo}/actions/runs/${run.id}`);
    const jobs = await gh<{ jobs: { steps?: { name: string; status: string }[] }[] }>(`/repos/${row.repo}/actions/runs/${run.id}/jobs`).catch(() => ({ jobs: [] }));
    const steps = jobs.jobs.flatMap((j) => j.steps ?? []);
    const doneSteps = steps.filter((s) => s.status === "completed").length;
    const cur = steps.find((s) => s.status === "in_progress")?.name ?? (r.status === "queued" ? "Waiting for a GitHub runner" : r.status);
    const p = steps.length ? 0.3 + 0.55 * (doneSteps / steps.length) : 0.3;
    if (cur !== last) {
      log(`  run ${r.status}: ${cur}`);
      last = cur;
    }
    await update({ status: r.status === "queued" ? "queued" : "running", step: `GitHub Actions: ${cur}`, progress: p });
    if (r.status === "completed") return r;
    await sleep(8000);
  }
}

async function download(row: CloudRender, run: Run) {
  const a = await gh<{ artifacts: { id: number; name: string; archive_download_url: string; size_in_bytes: number }[] }>(`/repos/${row.repo}/actions/runs/${run.id}/artifacts`);
  const art = a.artifacts.find((x) => x.name === "reelsmith-render");
  if (!art) throw new Error("The run finished without the reelsmith-render artifact");
  await update({ artifactId: String(art.id), status: "downloading", step: `Downloading ${(art.size_in_bytes / 1e6).toFixed(1)} MB`, progress: 0.88 });
  const res = await gh<Response>(art.archive_download_url, { raw: true, signal: AbortSignal.timeout(15 * 60_000) });
  if (!res.ok) throw new Error(`Artifact download failed (HTTP ${res.status})`);
  const zip = readZip(Buffer.from(await res.arrayBuffer()), 2 * 1024 * 1024 * 1024);
  const video = zip.get("video.mp4");
  if (!video) throw new Error("The artifact has no video.mp4");
  const rep = zip.get("report.json") ? (JSON.parse(zip.get("report.json")!.toString("utf8")) as { duration: number; report: unknown; seconds: number }) : null;
  const render = await prisma.renderJob.create({
    data: { projectId: row.projectId, userId: row.userId, versionId: row.versionId, quality: row.quality, status: "processing", startedAt: row.createdAt },
  });
  const put = (key: string, data: Buffer) => {
    const p = path.join(storageDir(), key);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, data);
    return `/api/files/${key}`;
  };
  const key = `renders/${row.projectId}/${render.id}.mp4`;
  const url = put(key, video);
  const thumb = zip.get("thumb.jpg") ? put(`renders/${row.projectId}/${render.id}.jpg`, zip.get("thumb.jpg")!) : null;
  await prisma.$transaction([
    prisma.renderJob.update({
      where: { id: render.id },
      data: { status: "done", progress: 1, outputUrl: url, outputKey: key, thumbUrl: thumb, duration: rep?.duration ?? null, report: { ...((rep?.report as object) ?? {}), cloud: { repo: row.repo, runUrl: run.html_url, seconds: rep?.seconds ?? null } } as Prisma.InputJsonValue, finishedAt: new Date() },
    }),
    prisma.project.updateMany({ where: { id: row.projectId, status: { in: ["ready", "rendered"] } }, data: { status: "rendered", ...(thumb ? { thumbnailUrl: thumb } : {}) } }),
  ]);
  log(`Saved the video to the project (${(video.length / 1e6).toFixed(1)} MB)`);
  return render.id;
}

async function cleanup(row: CloudRender, uploaded: boolean) {
  const fresh = (await prisma.cloudRender.findUnique({ where: { id } }))!;
  const problems: string[] = [];
  const del = async (label: string, p: string) => {
    try {
      await gh(p, { method: "DELETE" });
      log(`  deleted ${label}`);
    } catch (e) {
      if (!/ 404:/.test((e as Error).message)) problems.push(`${label}: ${(e as Error).message}`);
    }
  };
  if (uploaded && !row.keep) {
    await update({ status: "cleaning", step: "Deleting the uploaded branch, run and artifact", progress: 0.95 });
    if (fresh.artifactId) await del("artifact", `/repos/${row.repo}/actions/artifacts/${fresh.artifactId}`);
    if (fresh.runId) await del("workflow run + logs", `/repos/${row.repo}/actions/runs/${fresh.runId}`);
    await del(`branch ${row.branch}`, `/repos/${row.repo}/git/refs/heads/${row.branch}`);
  } else if (uploaded) log(`Kept on GitHub: branch ${row.branch}, the run and its artifact (Settings: keep).`);
  rmSync(path.dirname(row.bundleDir ?? path.join(storageDir(), "cloud", id, "bundle")), { recursive: true, force: true });
  return problems;
}

async function main() {
  const row = await prisma.cloudRender.findUnique({ where: { id } });
  if (!row) throw new Error(`cloud render ${id} not found`);
  if (!row.bundleDir || !existsSync(row.bundleDir)) throw new Error("The prepared bundle is gone: prepare the cloud render again");
  let failure: Error | null = null;
  let uploaded = false;
  try {
    await update({ status: "uploading", step: "Checking the repo is private", progress: 0.02 });
    await verifyPrivateRepo(row.repo); // checked again right before any footage leaves the machine
    const owner = row.repo.split("/")[0];
    const sha = await upload(row);
    uploaded = true;
    await update({ status: "queued", step: "Waiting for GitHub Actions", progress: 0.3 });
    const run = await waitForRun(row, sha);
    await update({ runId: String(run.id), runUrl: run.html_url });
    log(`Actions run: ${run.html_url}`);
    const done = await follow(row, run);
    if (done.conclusion !== "success") throw new Error(`The Actions run ended "${done.conclusion}". Its log: ${done.html_url}`);
    const renderId = await download(row, done);
    const info = await gh<{ owner: { type: string } }>(`/repos/${row.repo}`).catch(() => ({ owner: { type: "User" } }));
    const minutes = await actionsMinutes(owner, info.owner.type).catch(() => null);
    await update({ renderJobId: renderId, ...(minutes ? { minutes } : {}) });
  } catch (e) {
    failure = e as Error;
    log(`ERROR: ${failure.message}`);
  } finally {
    const problems = await cleanup(row, uploaded);
    await update({
      status: failure ? "failed" : "done",
      step: failure ? "Failed" : row.keep ? "Done (uploads kept on GitHub)" : "Done (uploads deleted)",
      progress: failure ? undefined : 1,
      error: [failure?.message, ...problems].filter(Boolean).join(" · ").slice(0, 3000) || null,
      cleanedUp: !row.keep && problems.length === 0,
      finishedAt: new Date(),
    });
    await prisma.$disconnect();
  }
  if (failure) process.exit(1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.cloudRender.update({ where: { id }, data: { status: "failed", error: String((e as Error).message ?? e), finishedAt: new Date() } }).catch(() => {});
  process.exit(1);
});
