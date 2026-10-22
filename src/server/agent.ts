import "server-only";
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { prisma } from "./db";
import { PROJECT_SUBDIRS, projectDir, RUNNER_STALE_MS, runnerDir, runnerStatusPath, type RunnerStatus } from "@/agent/config";
import type { SchemaName } from "@/agent/schemas";
import type { Timeline } from "@/lib/timeline/types";
import { keyFromUrl, localPath } from "./storage";

export interface NewJob {
  /** Pick the id up front, e.g. to name the job's own output file (default: random). */
  id?: string;
  userId: string;
  projectId?: string | null;
  kind: string;
  title: string;
  prompt: string;
  /** Continue this claude session (--resume) instead of starting a new one. */
  resumeSessionId?: string | null;
  outputFile?: string;
  schema?: SchemaName;
  timeoutSec?: number;
  /** Delete an existing outputFile first, so a stale result can't pass validation. */
  freshOutput?: boolean;
  /** A local command (argv) instead of a claude run. Built server-side only. */
  exec?: string[];
  /** Run only after this job is done (the runner fails it if that one fails). */
  afterJobId?: string;
  /** Work folder when it isn't the project folder (Write is allowed only there), e.g. a creator profile. */
  workDir?: string;
}

export function ensureProjectDir(projectId: string) {
  const dir = projectDir(projectId);
  for (const sub of PROJECT_SUBDIRS) mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

/** Queue a headless claude run; the agent runner picks it up. */
export async function createJob(j: NewJob) {
  const id = j.id ?? crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const dir = j.workDir ? path.resolve(j.workDir) : j.projectId ? ensureProjectDir(j.projectId) : runnerDir();
  mkdirSync(path.join(dir, "jobs"), { recursive: true });
  if (j.freshOutput && j.outputFile) rmSync(path.join(dir, j.outputFile), { force: true });
  return prisma.agentJob.create({
    data: {
      id,
      userId: j.userId,
      projectId: j.projectId ?? null,
      kind: j.kind,
      title: j.title,
      prompt: j.prompt,
      sessionId: j.resumeSessionId ?? crypto.randomUUID(),
      resume: Boolean(j.resumeSessionId),
      outputFile: j.outputFile ?? null,
      schema: j.schema ?? null,
      timeoutSec: j.timeoutSec ?? 900,
      exec: j.exec ? JSON.stringify(j.exec) : null,
      workDir: j.workDir ?? null,
      afterJobId: j.afterJobId ?? null,
      logPath: path.join(dir, "jobs", `${id}.ndjson`),
    },
  });
}

/** The most recent finished session of this kind in a project, to resume it. */
export async function lastSession(projectId: string, kind: string) {
  const j = await prisma.agentJob.findFirst({
    where: { projectId, kind, status: "done" },
    orderBy: { createdAt: "desc" },
    select: { sessionId: true },
  });
  return j?.sessionId ?? null;
}

/**
 * The project's one ongoing Claude conversation: chat instructions, the spoken-cut plan, its revisions and the
 * style pass all resume the latest finished session among these kinds, so every step remembers the earlier ones.
 */
export const WORKFLOW_KINDS = ["chat", "plan", "style", "taste_rule"] as const;
export async function projectSession(projectId: string) {
  const j = await prisma.agentJob.findFirst({
    where: { projectId, kind: { in: [...WORKFLOW_KINDS] }, status: "done" },
    orderBy: { createdAt: "desc" },
    select: { sessionId: true },
  });
  return j?.sessionId ?? null;
}

export function readResult<T>(projectId: string, file: string): T | null {
  const p = path.join(projectDir(projectId), file);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, "")) as T;
  } catch {
    return null;
  }
}

export type RunnerState = { online: boolean; status: RunnerStatus | null };

export function runnerState(): RunnerState {
  try {
    const s = JSON.parse(readFileSync(runnerStatusPath(), "utf8")) as RunnerStatus;
    return { online: Date.now() - Date.parse(s.heartbeatAt) < RUNNER_STALE_MS, status: s };
  } catch {
    return { online: false, status: null };
  }
}

export const jobDTO = (j: Awaited<ReturnType<typeof createJob>>) => ({
  id: j.id,
  projectId: j.projectId,
  kind: j.kind,
  title: j.title,
  status: j.status,
  error: j.error,
  resultText: j.resultText,
  costUsd: j.costUsd,
  turns: j.turns,
  fixAttempts: j.fixAttempts,
  sessionId: j.sessionId,
  outputFile: j.outputFile,
  exec: Boolean(j.exec), // a local command job (no claude)
  createdAt: j.createdAt.toISOString(),
  startedAt: j.startedAt?.toISOString() ?? null,
  finishedAt: j.finishedAt?.toISOString() ?? null,
});
export type AgentJobDTO = ReturnType<typeof jobDTO>;

/** Absolute path of a media URL on this machine (local storage or the app's public/ folder). */
export function localMediaPath(url: string | null | undefined): string | null {
  if (!url) return null;
  const key = keyFromUrl(url);
  if (key) {
    try {
      const p = localPath(key);
      return existsSync(p) ? p : null;
    } catch {
      return null;
    }
  }
  if (url.startsWith("/")) {
    const p = path.join(process.cwd(), "public", decodeURIComponent(url.split("?")[0]));
    return existsSync(p) ? p : null;
  }
  return null;
}

/** Every distinct local media file a project's timeline uses (video, image, voice, music). */
export function timelineMediaFiles(tl: Timeline): string[] {
  const out = new Set<string>();
  for (const t of tl.tracks) for (const c of t.clips as { src?: string | null }[]) {
    const p = localMediaPath(c.src);
    if (p) out.add(p);
  }
  return [...out];
}
