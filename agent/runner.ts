/**
 * ReelSmith agent runner: runs queued AgentJobs one at a time as headless
 * `claude -p` processes on the user's Claude subscription.
 *
 *   npm run agent
 *
 * - cwd is the reel-studio workspace (skills, taste-checklist.md, gotchas.md); --add-dir gives access to the project folder.
 * - After every job, problems the run reported fixing (jobs/<id>.gotchas.json) and result files that failed validation and
 *   were fixed are filed in gotchas.md (taste checklist R3).
 * - ANTHROPIC_API_KEY & co. are removed from the child env, so runs never bill the API.
 * - stream-json output is appended to the job's log (one JSON object per line); the web
 *   app tails that file over SSE.
 * - Cancel (from the UI) and timeouts kill the whole process tree.
 * - Results are JSON files in the project folder, validated against src/agent/schemas.ts;
 *   on failure the same session is resumed and asked to fix the file (up to 2 times).
 * - Jobs with `exec` (a JSON argv, built server-side only) are local commands instead of claude runs,
 *   e.g. a Real-ESRGAN upscale that takes hours: same queue, log, cancel and timeout.
 * - Every claude run uses the user's Claude subscription. A run that hits the usage limit fails with the reset time.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, type WriteStream } from "node:fs";
import path from "node:path";
import { PrismaClient, type AgentJob } from "@prisma/client";
import { resolveClaude, type ClaudeCommand } from "../src/agent/claude-bin";
import { claudeArgs, systemPrompt } from "../src/agent/claude-args";
import {
  appDir,
  billingWarnings,
  claudeEnv,
  creatorDir,
  PROJECT_SUBDIRS,
  projectDir,
  runnerDir,
  runnerStatusPath,
  RUNNER_STALE_MS,
  storageDir,
  studioDir,
  styleDir,
  type RunnerStatus,
} from "../src/agent/config";
import { validateResult } from "../src/agent/schemas";
import { addGotcha } from "../src/agent/rulesfile";
import { sessionExists, usageLimitHit } from "../src/agent/engine";

loadEnv();
const prisma = new PrismaClient();
const POLL_MS = 1000;
const MAX_FIXES = 2;

let claude: ClaudeCommand;
const status: RunnerStatus = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
  claude: null,
  auth: null,
  warnings: [],
  currentJobId: null,
  claudeLimitedUntil: null,
};
/** Claude's usage limit: set when a run reports it, cleared when the reset time passes. */
let claudeLimitedUntil: number | null = null;
const LIMIT_DEFAULT_MS = 30 * 60_000; // when Claude doesn't say when the limit resets, try it again after 30 min

function setLimited(until: number | null) {
  claudeLimitedUntil = until;
  status.claudeLimitedUntil = until ? new Date(until).toISOString() : null;
}

/** Read ../.env like the Python worker does (Next.js loads it itself). */
function loadEnv() {
  const env = path.resolve(__dirname, "..", ".env");
  if (!existsSync(env)) return;
  for (const raw of readFileSync(env, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function log(...a: unknown[]) {
  console.log(`[agent ${new Date().toLocaleTimeString()}]`, ...a);
}

function writeStatus() {
  status.heartbeatAt = new Date().toISOString();
  try {
    writeFileSync(runnerStatusPath(), JSON.stringify(status, null, 2));
  } catch (err) {
    console.error("[agent] could not write status", err);
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a process and all its children (claude -> bash -> ffmpeg/python). */
function killTree(pid: number) {
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
}

function startupChecks() {
  mkdirSync(runnerDir(), { recursive: true });
  // single instance: a fresh status file from another live pid means a runner is already up
  if (existsSync(runnerStatusPath())) {
    try {
      const prev = JSON.parse(readFileSync(runnerStatusPath(), "utf8")) as RunnerStatus;
      if (prev.pid !== process.pid && alive(prev.pid) && Date.now() - Date.parse(prev.heartbeatAt) < RUNNER_STALE_MS) {
        console.error(`[agent] another runner is already running (pid ${prev.pid}). Exiting.`);
        process.exit(1);
      }
    } catch {
      /* unreadable: overwrite */
    }
  }

  status.warnings = billingWarnings();
  for (const w of status.warnings) console.warn(`[agent] WARNING: ${w}`);

  claude = resolveClaude();
  const env = claudeEnv();
  const run = (args: string[]) =>
    spawnSync(claude.command, [...claude.prefixArgs, ...args], { env, encoding: "utf8", windowsHide: true, timeout: 60_000 });
  const ver = run(["--version"]);
  status.claude = { command: claude.command, version: ver.stdout?.trim() || null };
  if (ver.status !== 0) throw new Error(`claude --version failed: ${ver.stderr || ver.error}`);

  const auth = run(["auth", "status"]);
  try {
    const a = JSON.parse(auth.stdout);
    status.auth = { loggedIn: Boolean(a.loggedIn), authMethod: a.authMethod, subscriptionType: a.subscriptionType };
  } catch {
    status.auth = { loggedIn: false };
  }
  if (!status.auth.loggedIn) status.warnings.push("Claude Code is not logged in. Run `claude` once in a terminal and log in with your Claude subscription.");
  else if (status.auth.authMethod !== "claude.ai")
    status.warnings.push(`Claude Code is logged in with "${status.auth.authMethod}", not a Claude subscription (claude.ai). Runs may be billed. Run \`claude auth logout\`, then log in with your subscription.`);

  if (!existsSync(path.join(studioDir(), ".claude", "skills", "video-use", "SKILL.md")))
    status.warnings.push(`video-use skill not found in ${studioDir()}\\.claude\\skills. Clone github.com/browser-use/video-use into that folder.`);

  log(`claude: ${status.claude.version} (${claude.command})`);
  log(`auth: ${status.auth.loggedIn ? `${status.auth.authMethod} / ${status.auth.subscriptionType}` : "NOT LOGGED IN"}`);
  log(`workspace: ${studioDir()}  storage: ${storageDir()}`);
}

async function recoverStale() {
  const r = await prisma.agentJob.updateMany({
    where: { status: "running" },
    data: { status: "failed", error: "The agent runner restarted while this job was running.", finishedAt: new Date(), pid: null },
  });
  if (r.count) log(`marked ${r.count} interrupted job(s) as failed`);
}

async function claim(): Promise<AgentJob | null> {
  // a job waiting on another fails when that one failed or was cancelled
  const waiting = await prisma.agentJob.findMany({ where: { status: "queued", afterJobId: { not: null } }, select: { id: true, afterJobId: true } });
  const ready = new Set<string>();
  for (const w of waiting) {
    const dep = await prisma.agentJob.findUnique({ where: { id: w.afterJobId! }, select: { status: true, title: true } });
    if (!dep || dep.status === "failed" || dep.status === "cancelled") {
      await prisma.agentJob.update({
        where: { id: w.id },
        data: { status: dep?.status === "cancelled" ? "cancelled" : "failed", error: `Skipped: "${dep?.title ?? "the previous step"}" ${dep?.status ?? "is missing"}`, finishedAt: new Date() },
      });
    } else if (dep.status === "done") ready.add(w.id);
  }
  const next = await prisma.agentJob.findFirst({
    where: { status: "queued", cancelRequested: false, OR: [{ afterJobId: null }, { id: { in: [...ready] } }] },
    orderBy: { createdAt: "asc" },
  });
  if (!next) return null;
  const got = await prisma.agentJob.updateMany({ where: { id: next.id, status: "queued" }, data: { status: "running", startedAt: new Date() } });
  return got.count ? { ...next, status: "running" } : null;
}

type Outcome = { code: number | null; killed: "cancel" | "timeout" | null; result: Record<string, unknown> | null };

/** One claude process (a new session or a resumed turn). Appends everything to the log. */
function runClaude(job: AgentJob, out: WriteStream, prompt: string, resume: boolean, deadline: number): Promise<Outcome> {
  const dir = jobDir(job);
  const sysFile = path.join(dir, "jobs", `${job.id}.system.md`);
  const extraDirs = [styleDir(), creatorDir()].filter((d) => existsSync(d) && path.resolve(d) !== path.resolve(dir));
  writeFileSync(sysFile, systemPrompt({ projectDir: dir, outputFile: job.outputFile, extraDirs, jobId: job.id }));
  const args = claudeArgs({ sessionId: job.sessionId, resume, projectDir: dir, extraDirs, systemPromptFile: sysFile });

  return new Promise((resolve) => {
    const child: ChildProcess = spawn(claude.command, [...claude.prefixArgs, ...args], {
      cwd: studioDir(),
      env: claudeEnv(),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", // own process group, so killTree reaches the children
    });
    let result: Record<string, unknown> | null = null;
    let killed: Outcome["killed"] = null;
    let buf = "";
    prisma.agentJob.update({ where: { id: job.id }, data: { pid: child.pid ?? null } }).catch(() => {});

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trimEnd();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        out.write(line + "\n");
        try {
          const e = JSON.parse(line);
          if (e.type === "result") result = e;
        } catch {
          /* non-JSON line, logged as-is */
        }
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      for (const l of chunk.split(/\r?\n/).filter((x) => x.trim())) out.write(JSON.stringify({ type: "reelsmith", level: "warn", text: `stderr: ${l}` }) + "\n");
    });

    const watch = setInterval(async () => {
      if (killed || child.exitCode !== null) return;
      if (Date.now() > deadline) killed = "timeout";
      else {
        const row = await prisma.agentJob.findUnique({ where: { id: job.id }, select: { cancelRequested: true } }).catch(() => null);
        if (row?.cancelRequested) killed = "cancel";
      }
      if (killed && child.pid) {
        log(`${job.id}: ${killed === "cancel" ? "cancelled" : "timed out"}, killing process tree ${child.pid}`);
        killTree(child.pid);
      }
    }, POLL_MS);

    child.on("error", (err) => {
      out.write(JSON.stringify({ type: "reelsmith", level: "error", text: `Could not start claude: ${err.message}` }) + "\n");
    });
    child.on("close", (code) => {
      clearInterval(watch);
      if (buf.trim()) out.write(buf.trim() + "\n");
      resolve({ code, killed, result });
    });

    child.stdin!.end(prompt, "utf8");
  });
}

/** A local command job: stdout/stderr lines become log notes. */
function runExec(job: AgentJob, out: WriteStream, deadline: number): Promise<{ code: number | null; killed: Outcome["killed"] }> {
  const [cmd, ...args] = JSON.parse(job.exec!) as string[];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: appDir(),
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let killed: Outcome["killed"] = null;
    prisma.agentJob.update({ where: { id: job.id }, data: { pid: child.pid ?? null } }).catch(() => {});
    const pipe = (level: "info" | "warn") => (chunk: Buffer) => {
      for (const l of chunk.toString("utf8").split(/\r?\n/).filter((x) => x.trim())) note(out, level, l);
    };
    child.stdout!.on("data", pipe("info"));
    child.stderr!.on("data", pipe("warn"));
    const watch = setInterval(async () => {
      if (killed || child.exitCode !== null) return;
      if (Date.now() > deadline) killed = "timeout";
      else {
        const row = await prisma.agentJob.findUnique({ where: { id: job.id }, select: { cancelRequested: true } }).catch(() => null);
        if (row?.cancelRequested) killed = "cancel";
      }
      if (killed && child.pid) killTree(child.pid);
    }, POLL_MS);
    child.on("error", (err) => note(out, "error", `Could not start ${cmd}: ${err.message}`));
    child.on("close", (code) => {
      clearInterval(watch);
      resolve({ code, killed });
    });
  });
}

/** Where a job works: its own workDir (e.g. a creator profile), the project folder, or the runner folder. */
function jobDir(job: AgentJob) {
  return job.workDir ? path.resolve(job.workDir) : job.projectId ? projectDir(job.projectId) : runnerDir();
}

function note(out: WriteStream, level: "info" | "warn" | "error", text: string) {
  out.write(JSON.stringify({ type: "reelsmith", level, text }) + "\n");
}

function readJson(file: string): { ok: true; data: unknown } | { ok: false; error: string } {
  if (!existsSync(file)) return { ok: false, error: "the file does not exist" };
  try {
    return { ok: true, data: JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) };
  } catch (err) {
    return { ok: false, error: `not valid JSON (${(err as Error).message})` };
  }
}

async function process1(job: AgentJob) {
  status.currentJobId = job.id;
  writeStatus();
  const dir = jobDir(job);
  for (const sub of job.workDir ? ["jobs"] : PROJECT_SUBDIRS) mkdirSync(path.join(dir, sub), { recursive: true });
  mkdirSync(path.dirname(job.logPath), { recursive: true });
  const out = createWriteStream(job.logPath, { flags: "a" });
  const deadline = Date.now() + job.timeoutSec * 1000;
  log(`${job.id}: start ${job.kind} "${job.title}" (${job.resume ? "resume" : "new"} session ${job.sessionId})`);
  note(out, "info", `Started ${job.resume ? "a resumed turn" : "a new session"} · timeout ${Math.round(job.timeoutSec / 60)} min`);

  let final: { status: string; error?: string | null; resultText?: string | null } = { status: "failed", error: "Unknown error" };
  let costUsd = 0;
  let turns = 0;
  let fixes = 0;
  let prompt = job.prompt;
  const invalid: string[] = []; // validation errors that a fix-up turn then solved (filed as a gotcha)
  // a resumed session whose transcript is gone (e.g. claude's history was cleared) starts fresh under the same id
  let resume = job.resume && !job.exec && sessionExists(job.sessionId);
  if (job.resume && !job.exec && !resume) note(out, "warn", "The previous session's transcript was not found: starting a new session.");
  try {
    if (!job.exec && claudeLimitedUntil !== null) {
      if (claudeLimitedUntil <= Date.now()) setLimited(null);
      else throw new Error(`Claude's usage limit is reached (resets about ${new Date(claudeLimitedUntil).toLocaleTimeString()}). Retry after the reset.`);
    }
    if (job.exec) {
      const o = await runExec(job, out, deadline);
      final =
        o.killed === "cancel"
          ? { status: "cancelled", error: "Cancelled" }
          : o.killed === "timeout"
            ? { status: "failed", error: `Timed out after ${Math.round(job.timeoutSec / 60)} min` }
            : o.code === 0
              ? { status: "done" }
              : { status: "failed", error: `Exited with code ${o.code}` };
      if (final.error) note(out, final.status === "cancelled" ? "warn" : "error", final.error);
    }
    for (; !job.exec; ) {
      const o = await runClaude(job, out, prompt, resume, deadline);
      resume = sessionExists(job.sessionId); // any follow-up continues the same session
      costUsd += Number(o.result?.total_cost_usd ?? 0);
      turns += Number(o.result?.num_turns ?? 0);
      if (o.killed === "cancel") {
        final = { status: "cancelled", error: "Cancelled" };
        note(out, "warn", "Cancelled: the process tree was stopped.");
        break;
      }
      if (o.killed === "timeout") {
        final = { status: "failed", error: `Timed out after ${Math.round(job.timeoutSec / 60)} min` };
        note(out, "error", final.error!);
        break;
      }
      const r = o.result;
      const limit = usageLimitHit(r ? String(r.result ?? "") : null);
      if (limit.hit && (!r || r.is_error || r.subtype !== "success")) {
        setLimited(limit.resetsAt ?? Date.now() + LIMIT_DEFAULT_MS);
        writeStatus();
        final = { status: "failed", error: `Claude's usage limit is reached (resets about ${new Date(claudeLimitedUntil!).toLocaleTimeString()}). Retry after the reset.` };
        note(out, "error", final.error!);
        break;
      }
      if (!r || r.is_error || r.subtype !== "success") {
        const msg = r ? String(r.result || r.subtype || "error") : `claude exited with code ${o.code} and no result`;
        final = { status: "failed", error: msg.slice(0, 1000), resultText: r ? String(r.result ?? "") : null };
        note(out, "error", `Claude run failed: ${msg.slice(0, 300)}`);
        break;
      }
      const resultText = String(r.result ?? "");
      if (!job.outputFile || !job.schema) {
        final = { status: "done", resultText };
        break;
      }
      const file = path.join(dir, job.outputFile);
      const parsed = readJson(file);
      const v = parsed.ok ? validateResult(job.schema, parsed.data) : { ok: false as const, errors: [parsed.error] };
      if (v.ok) {
        final = { status: "done", resultText };
        note(out, "info", `${job.outputFile} is valid.`);
        break;
      }
      if (fixes >= MAX_FIXES) {
        final = { status: "failed", error: `${job.outputFile} is still invalid after ${MAX_FIXES} fixes: ${v.errors.join("; ")}`.slice(0, 1000), resultText };
        note(out, "error", final.error!);
        break;
      }
      fixes++;
      invalid.push(...v.errors);
      note(out, "warn", `${job.outputFile} failed validation (attempt ${fixes}/${MAX_FIXES} to fix): ${v.errors.join("; ")}`);
      await prisma.agentJob.update({ where: { id: job.id }, data: { fixAttempts: fixes } });
      prompt = `The result file ${job.outputFile} failed validation:\n${v.errors.map((e) => `- ${e}`).join("\n")}\n\nFix the file in place so it matches the requested shape exactly. Keep everything that was already correct.`;
    }
  } catch (err) {
    final = { status: "failed", error: (err as Error).message };
    note(out, "error", final.error!);
  }
  fileGotchas(job, dir, final.status === "done" ? invalid : [], out);
  await new Promise<void>((r) => out.end(r));
  await prisma.agentJob.update({
    where: { id: job.id },
    data: { ...final, costUsd, turns, fixAttempts: fixes, pid: null, finishedAt: new Date() },
  });
  log(`${job.id}: ${final.status}${final.error ? ` (${final.error.slice(0, 120)})` : ""}`);
  status.currentJobId = null;
  writeStatus();
}

/** Taste checklist R3: what broke during the run and got fixed goes into gotchas.md before the next job starts. */
function fileGotchas(job: AgentJob, dir: string, invalid: string[], out: WriteStream) {
  const filed: string[] = [];
  try {
    if (invalid.length && job.outputFile) {
      // "texts.0.accent: Invalid input ..." -> "texts.*.accent": the same mistake on another item is the same gotcha
      const paths = [...new Set(invalid.map((e) => e.split(":")[0].replace(/\.\d+(?=\.|$)/g, ".*").trim()))].sort();
      const r = addGotcha({
        title: `${job.outputFile} failed validation (${paths.join(", ")})`.slice(0, 160),
        problem: `A ${job.kind} job wrote ${job.outputFile} that didn't match its schema "${job.schema}": ${invalid.slice(0, 4).join("; ")}`.slice(0, 600),
        why: "The prompt's description of those fields let Claude guess the type or value.",
        fix: "The runner resumed the session with the exact errors and Claude fixed the file. If this keeps happening, list the exact allowed values for these fields in the prompt.",
        area: "agent",
        key: `schema:${job.schema}:${paths.join(",")}`,
      });
      filed.push(r.gotcha.id);
    }
    const f = path.join(dir, "jobs", `${job.id}.gotchas.json`);
    const parsed = readJson(f);
    if (parsed.ok) {
      const list = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
      for (const g of list as Record<string, unknown>[]) {
        const s = (k: string) => (typeof g?.[k] === "string" ? (g[k] as string).trim() : "");
        if (!s("title") || !s("fix")) continue;
        const r = addGotcha({ title: s("title").slice(0, 160), problem: s("problem") || s("title"), why: s("why") || "not known", fix: s("fix"), area: s("area") || "other" });
        filed.push(r.gotcha.id);
      }
    }
  } catch (err) {
    note(out, "warn", `Couldn't file gotchas: ${(err as Error).message}`);
  }
  if (filed.length) note(out, "info", `Filed in gotchas.md: ${filed.join(", ")}`);
}

async function main() {
  startupChecks();
  writeStatus();
  const beat = setInterval(writeStatus, 5000);
  await recoverStale();
  log(`ready, polling every ${POLL_MS / 1000}s`);
  let stopping = false;
  const stop = () => {
    stopping = true;
    clearInterval(beat);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopping) {
    try {
      const job = await claim();
      if (job) await process1(job);
      else await new Promise((r) => setTimeout(r, POLL_MS));
    } catch (err) {
      console.error("[agent] loop error", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[agent] fatal:", err);
  process.exit(1);
});
