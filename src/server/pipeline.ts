import "server-only";
// Two-stage approval (taste checklist R45).
//   Stage 1 - the spoken cut only: the plan modes (src/server/modes.ts; last take wins, pauses and fillers removed).
//             The user approves it on the plan screen or sends timestamped fixes ("Around 0:18, ...") = one revision.
//   Stage 2 - the style pass: creator style.json + taste rules + brand kit -> timeline ops (a Claude job, kind
//             "style", same session as the chat and the cut), then key stills (hook, caption moments, cards,
//             transitions) rendered by the export engine (worker/stills.py). Rendering is allowed only after the
//             user approves the stills.
//   Before the stills are shown, a fresh checker checks them against the taste checklist (R5, src/server/rulecheck.ts):
//   stills -> check -> (failures) one style revision from the same session -> stills again -> review, with the report.
// State lives in Project.pipeline. The editor applies the style ops itself (undoable, autosaved) and reports back,
// then the stills are rendered from exactly that timeline.
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Prisma, Project } from "@prisma/client";
import { fwd, workerPython, appDir } from "@/agent/config";
import { stylePassSchema, type StylePass } from "@/agent/schemas";
import { describeForAi, type AiOp } from "@/lib/timeline/ai";
import { clipEnd, mappedWords } from "@/lib/timeline/derive";
import type { AnyClip, Timeline } from "@/lib/timeline/types";
import { LAYER_LABEL } from "@/lib/style/layers";
import { fixesBlock, type Fix } from "@/lib/chat/fixes";
import { createJob, ensureProjectDir, projectSession } from "./agent";
import { AI_EDIT_OPS, resolveAiEdit } from "./aiedit";
import { prisma } from "./db";
import { HttpError } from "./http";
import { isPlanMode } from "./modes";
import { creatorFolder, readCreatorStyle, styleLayers } from "./style";
import { absorbNotes, notesBlock } from "./rules";
import { failCheck, finishCheck, fixBrief, startCheck, takeReport } from "./rulecheck";

export type Stage = "cut" | "cut_review" | "cut_approved" | "style" | "style_ready" | "stills" | "check" | "stills_review" | "approved";
export const STAGE_LABEL: Record<Stage, string> = {
  cut: "Stage 1 · Claude is cutting the speech",
  cut_review: "Stage 1 · Review the spoken cut",
  cut_approved: "Stage 1 approved · ready for the style pass",
  style: "Stage 2 · Claude is styling",
  style_ready: "Stage 2 · Applying the style pass",
  stills: "Stage 2 · Rendering key stills",
  check: "Stage 2 · A fresh checker is checking the stills against your taste checklist",
  stills_review: "Stage 2 · Review the key stills",
  approved: "Stills approved · ready to render",
};

export interface Still {
  t: number;
  kind: string;
  label: string;
  why?: string;
  file: string | null; // relative to the project folder
}
export interface Conflict {
  topic: string;
  winner: "taste" | "brand" | "creator" | "default";
  chosen: string;
  overridden: { layer: string; value: string }[];
  rule?: string;
}
export interface Pipeline {
  stage: Stage;
  creator: string | null;
  brief: string;
  pendingStyle: boolean; // run the style pass as soon as the cut is approved
  styleJobId: string | null;
  style: { jobId: string; summary: string; ops: (AiOp & { why?: string })[]; picks: Omit<Still, "file">[]; applied: boolean } | null;
  conflicts: Conflict[];
  stillsJobId: string | null;
  stills: Still[];
  stillsHash: string | null;
  approvedHash: string | null;
  approvedAt: string | null;
  error: string | null;
  /** the rule check of the current stills (R5): 0 = not checked yet, 1 = its fix round ran (don't check the fixed stills again) */
  checkId: string | null;
  checkRound: number;
}

const EMPTY: Pipeline = {
  stage: "cut_approved",
  creator: null,
  brief: "",
  pendingStyle: false,
  styleJobId: null,
  style: null,
  conflicts: [],
  stillsJobId: null,
  stills: [],
  stillsHash: null,
  approvedHash: null,
  approvedAt: null,
  error: null,
  checkId: null,
  checkRound: 0,
};

export function getPipeline(p: Pick<Project, "pipeline">): Pipeline | null {
  return p.pipeline ? { ...EMPTY, ...(p.pipeline as object) } : null;
}

export async function savePipeline(projectId: string, pl: Pipeline) {
  await prisma.project.update({ where: { id: projectId }, data: { pipeline: pl as unknown as Prisma.InputJsonValue } });
  return pl;
}

/** Start (or update) a project's pipeline: called when the chat or a plan mode starts the workflow. */
export async function ensurePipeline(project: Project, patch: Partial<Pipeline> = {}) {
  const cur = getPipeline(project);
  const stage: Stage = cur?.stage ?? (["draft", "planning", "plan_failed"].includes(project.status) ? "cut" : project.status === "review" ? "cut_review" : "cut_approved");
  return savePipeline(project.id, { ...EMPTY, ...cur, stage, ...patch });
}

/** Stable hash of what a render would show (key order independent: Postgres jsonb reorders keys). */
export function timelineHash(tl: Timeline) {
  const stable = (v: unknown): string =>
    Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v ?? null);
  const { tracks, captions, fx, transcripts, aspect, background } = tl;
  return crypto.createHash("sha1").update(stable({ tracks, captions, fx: fx ?? [], transcripts, aspect, background })).digest("hex").slice(0, 16);
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Moments worth checking when Claude didn't pick them: the hook, text cards, transitions, captions, zoom hits. */
export function autoStills(tl: Timeline): Omit<Still, "file">[] {
  const T = Math.max(0, ...tl.tracks.flatMap((t) => (t.clips as AnyClip[]).map(clipEnd)));
  const out: Omit<Still, "file">[] = [{ t: Math.min(0.5, T / 4), kind: "hook", label: "Hook: the first frame people see" }];
  for (const tr of tl.tracks) {
    for (const c of tr.clips as AnyClip[]) {
      if (c.type === "text") out.push({ t: c.start + Math.min(0.5, c.duration / 2), kind: "card", label: `Text: “${c.text.slice(0, 40)}”` });
      else if (c.type !== "audio" && c.transition && c.transition.type !== "cut") out.push({ t: c.start + c.transition.duration / 2, kind: "transition", label: `${c.transition.type} transition` });
    }
  }
  if (tl.captions.enabled) {
    const words = mappedWords(tl);
    for (const f of [0.3, 0.65]) {
      const w = words.find((x) => x.start >= T * f);
      if (w) out.push({ t: w.start + 0.05, kind: "caption", label: `Caption: “${w.text}”` });
    }
  }
  const punch = (tl.fx ?? []).find((f) => f.type === "punch");
  if (punch) out.push({ t: punch.t + 0.05, kind: "zoom", label: "Zoom punch" });
  return dedupe(out, T);
}

function dedupe(list: Omit<Still, "file">[], T: number) {
  const sorted = list.filter((s) => s.t >= 0 && s.t < T).sort((a, b) => a.t - b.t);
  const out: Omit<Still, "file">[] = [];
  for (const s of sorted) if (!out.some((o) => Math.abs(o.t - s.t) < 0.4)) out.push({ ...s, t: r2(s.t) });
  return out.slice(0, 10);
}

// ---------------------------------------------------------------- stage 2: style pass

function styleFile(jobId: string) {
  return `style/${jobId}.json`;
}

export async function startStyle(
  project: Project,
  o: {
    timeline: Timeline;
    creator?: string | null;
    brief?: string;
    fixes?: Fix[];
    revise?: boolean;
    /** the brief/fixes are the user's own notes (not already filed by a chat turn): turn them into rules first (R2) */
    notes?: boolean;
    /** this revision fixes what a rule check found (R5) */
    checkFix?: { checkId: string; brief: string };
  },
) {
  if (!["ready", "rendered"].includes(project.status)) throw new HttpError(409, "Approve the spoken cut (stage 1) first");
  const cur = await ensurePipeline(project);
  const creator = o.creator !== undefined ? o.creator : cur.creator;
  const brief = o.brief ?? cur.brief;
  const layers = await styleLayers(project.userId, creator);
  if (creator && !layers.creator) throw new HttpError(400, `No style profile for @${creator} yet: run a creator teardown first`);
  const dir = ensureProjectDir(project.id);
  mkdirSync(path.join(dir, "style"), { recursive: true });
  const tlFile = path.join(dir, "edit", "style-timeline.json");
  writeFileSync(tlFile, JSON.stringify(describeForAi(o.timeline), null, 1));
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  writeFileSync(path.join(dir, "jobs", `${id}.base.json`), JSON.stringify(o.timeline));
  const words = mappedWords(o.timeline);
  const said = (f: Fix) => {
    const e = f.end ?? f.at + 1.5;
    const w = words.filter((x) => x.end > f.at - 0.5 && x.start < e + 0.5).map((x) => x.text).join(" ");
    return w ? `said around then: "${w.slice(0, 160)}"` : "no speech there";
  };
  const resolved = layers.topics.map((t) => `- ${t.label}: ${t.value}  [${LAYER_LABEL[t.winner]}${t.rule ? ` ${t.rule}` : ""}]${t.overridden.filter((x) => x.layer !== "default").length ? `  (overrides ${t.overridden.filter((x) => x.layer !== "default").map((x) => `${LAYER_LABEL[x.layer]}: ${x.value}`).join("; ")})` : ""}`);
  const cf = creator ? fwd(creatorFolder(creator)) : null;
  const prompt = `## ${o.revise ? "Revise the" : "Stage 2:"} style pass for "${project.title}"
The spoken cut is approved (stage 1). Never change what is said, the order, or the cut points of the speech: style only.

Current timeline: ${fwd(tlFile)} (clip ids, times, what is said, captions, fx, maxZoom per clip). Read it first.
Creator: ${cf ? `@${layers.creatorHandle}: ${cf}/style.json and ${cf}/teardown.md (read both)` : "none: use the taste rules, brand kit and defaults"}
Brand kit: ${layers.brand ? JSON.stringify(layers.brand) : "none"}
Taste rules (taste checklist, Type: taste): ${layers.taste.length ? `\n${layers.taste.map((r) => `- ${r.id} [${r.topic}] ${r.text}`).join("\n")}` : "none yet"}

## Priority: taste rules > brand kit > creator style.json > defaults
Resolved per topic by ReelSmith (follow it; a taste rule is the user's own words, apply its intent):
${resolved.join("\n")}
${brief ? `\n## Brief from the user\n${brief}\n` : ""}${o.fixes?.length ? `\n## Timestamped fixes (apply ALL of them in this one pass; times are timeline seconds)\n${fixesBlock(o.fixes, said)}\n` : ""}${o.checkFix ? `\n## Fix what the rule check found (this is the only change in this revision)\n${o.checkFix.brief}\n` : ""}${o.notes && (o.brief || o.fixes?.length) ? notesBlock(dir, id, o.fixes?.length ? "stills" : "chat") : ""}
## Do
1. Ops that apply the style to this timeline: captions (set_captions style/y/size), the hook (add_text title in the first 2-3 s when
   the style uses an on-screen hook), text cards, zooms (zoom with start/end over emphasis phrases, add_fx punch on emphasis words,
   at the creator's zooms-per-minute, never past maxZoom), transitions (set_clip transition), look (set_filters), music level (set_music).
   Text and captions stay inside the safe zone (y 0.14-0.79) and off the face. A fix for one moment is a fix at the cause: check the
   whole timeline for the same problem (R4).${o.revise ? " This is a revision: return only the ops for the CHANGES on top of the timeline as it is now (it already has the previous style pass)." : ""}
2. 4-8 key stills to check before rendering: the hook (t 0.3-0.8), 1-2 caption moments, every text card, every transition
   (mid-transition) and a zoom hit. "t" = timeline seconds AFTER your ops (removing nothing keeps times as they are).
3. conflicts: every topic where the layers disagreed: winner, the value you used ("chosen"), and the overridden values.
4. Write ${fwd(dir)}/${styleFile(id)} as {"summary", "ops", "stills": [{"t", "kind": "hook|caption|card|transition|zoom|other", "label", "why"}], "conflicts": [{"topic", "winner": "taste|brand|creator|default", "chosen", "overridden": [{"layer", "value"}], "rule"}]}.
   "summary" starts with what changed in one sentence.

## Operations
${AI_EDIT_OPS}`;
  const job = await createJob({
    id,
    userId: project.userId,
    projectId: project.id,
    kind: "style",
    title: `${o.revise ? "Style fixes" : "Style pass"}${creator ? ` · @${layers.creatorHandle}` : ""}`,
    prompt,
    resumeSessionId: await projectSession(project.id),
    outputFile: styleFile(id),
    schema: "style-pass",
    timeoutSec: 30 * 60,
  });
  await savePipeline(project.id, {
    ...cur,
    stage: "style",
    creator: creator ? layers.creatorHandle : null,
    brief,
    pendingStyle: false,
    styleJobId: job.id,
    style: null,
    conflicts: layers.conflicts.map((c) => ({ topic: c.label, winner: c.winner, chosen: c.value, overridden: c.overridden.filter((x) => x.layer !== "default"), rule: c.rule })),
    approvedHash: null,
    approvedAt: null,
    error: null,
    // a user's style pass gets a fresh rule check of its stills; the check's own fix round doesn't
    checkId: o.checkFix ? o.checkFix.checkId : null,
    checkRound: o.checkFix ? 1 : 0,
  });
  return job;
}

// ---------------------------------------------------------------- stills

export async function startStills(project: Project, tl: Timeline, picks?: Omit<Still, "file">[]) {
  const cur = await ensurePipeline(project);
  const dir = ensureProjectDir(project.id);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const out = path.join(dir, "edit", "stills", id);
  mkdirSync(out, { recursive: true });
  const T = Math.max(0, ...tl.tracks.flatMap((t) => (t.clips as AnyClip[]).map(clipEnd)));
  const list = dedupe([...(picks ?? []), ...autoStills(tl)].filter((s) => s.t < T), T);
  writeFileSync(path.join(out, "timeline.json"), JSON.stringify(tl));
  writeFileSync(path.join(out, "picks.json"), JSON.stringify(list));
  const job = await createJob({
    id,
    userId: project.userId,
    projectId: project.id,
    kind: "stills",
    title: `Key stills (${list.length})`,
    prompt: "(local command)",
    exec: [workerPython(), path.join(appDir(), "worker", "stills.py"), "--timeline", path.join(out, "timeline.json"), "--picks", path.join(out, "picks.json"), "--out", out],
    timeoutSec: 30 * 60,
  });
  await savePipeline(project.id, { ...cur, stage: "stills", stillsJobId: job.id, stillsHash: timelineHash(tl), stills: [], approvedHash: null, approvedAt: null, error: null });
  return job;
}

/** The editor applied the style ops (one undoable step) and sends the result: render its stills. */
export async function styleApplied(project: Project, jobId: string, tl: Timeline) {
  const cur = getPipeline(project);
  if (!cur?.style || cur.style.jobId !== jobId) throw new HttpError(409, "That style pass is no longer current");
  await savePipeline(project.id, { ...cur, style: { ...cur.style, applied: true } });
  return startStills(project, tl, cur.style.picks);
}

export async function approveStills(project: Project) {
  const cur = getPipeline(project);
  if (!cur || cur.stage !== "stills_review") throw new HttpError(409, "There are no stills waiting for approval");
  return savePipeline(project.id, { ...cur, stage: "approved", approvedHash: cur.stillsHash, approvedAt: new Date().toISOString() });
}

/** Render only after the stills are approved (projects that went through the style pass). */
export function renderGate(project: Pick<Project, "pipeline">, tl: Timeline | null) {
  const p = getPipeline(project);
  if (!p || ["cut", "cut_review", "cut_approved"].includes(p.stage)) return { ok: true as const, stage: p?.stage ?? null, changed: false };
  if (p.stage !== "approved") return { ok: false as const, stage: p.stage, changed: false, reason: `${STAGE_LABEL[p.stage]}. Approve the key stills before rendering.` };
  return { ok: true as const, stage: p.stage, changed: Boolean(tl && p.approvedHash && timelineHash(tl) !== p.approvedHash) };
}

// ---------------------------------------------------------------- poll-time transitions

/** Advance the pipeline from finished jobs: cut approved -> pending style pass, style done -> ops, stills done -> review. */
export async function syncPipeline(project: Project): Promise<Pipeline | null> {
  let p = getPipeline(project);
  if (!p) return null;
  const save = async (next: Pipeline) => (p = await savePipeline(project.id, next));

  if ((p.stage === "cut" || p.stage === "cut_review") && isPlanMode(project.mode)) {
    const stage: Stage = ["draft", "planning", "plan_failed"].includes(project.status) ? "cut" : project.status === "review" ? "cut_review" : "cut_approved";
    if (stage !== p.stage) await save({ ...p, stage });
  } else if (p.stage === "cut" || p.stage === "cut_review") {
    await save({ ...p, stage: "cut_approved" });
  }
  // the chat asked for a style pass before the cut was approved: run it now, from the freshly built timeline
  // (a creator whose teardown is still running: wait for its style.json)
  if (p.stage === "cut_approved" && p.pendingStyle && ["ready", "rendered"].includes(project.status) && !(p.creator && !readCreatorStyle(p.creator))) {
    const tl = await prisma.timeline.findUnique({ where: { projectId: project.id } });
    const cur: Pipeline = p;
    if (tl) {
      try {
        await startStyle({ ...project, pipeline: cur as unknown as Prisma.JsonValue }, { timeline: tl.json as unknown as Timeline });
        p = getPipeline((await prisma.project.findUnique({ where: { id: project.id } }))!);
      } catch (err) {
        await save({ ...cur, pendingStyle: false, error: (err as Error).message });
      }
    }
  }
  if (p && p.stage === "style" && p.styleJobId) {
    const job = await prisma.agentJob.findUnique({ where: { id: p.styleJobId } });
    if (job && ["done", "failed", "cancelled"].includes(job.status)) await absorbNotes(project, job.id, "stills");
    if (job && job.status === "done") {
      const dir = ensureProjectDir(project.id);
      const file = path.join(dir, styleFile(job.id));
      const parsed = stylePassSchema.safeParse(existsSync(file) ? JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) : null);
      const basePath = path.join(dir, "jobs", `${job.id}.base.json`);
      if (!parsed.success || !existsSync(basePath)) await save({ ...p, stage: "cut_approved", error: "The style pass result is missing or invalid" });
      else {
        const res: StylePass = parsed.data;
        const base = JSON.parse(readFileSync(basePath, "utf8")) as Timeline;
        const resolved = await resolveAiEdit(project.userId, base, { summary: res.summary, ops: res.ops });
        await save({
          ...p,
          stage: "style_ready",
          style: { jobId: job.id, summary: resolved.summary, ops: resolved.ops, picks: res.stills.map((s) => ({ ...s, t: r2(s.t) })), applied: false },
          conflicts: mergeConflicts(p.conflicts, res.conflicts),
        });
      }
    } else if (job && (job.status === "failed" || job.status === "cancelled")) {
      if (p.checkId && p.checkRound >= 1) await finishCheck(project, p.checkId, { fixFailed: `the fix pass ${job.status}` });
      await save({ ...p, stage: "cut_approved", error: job.error ?? `Style pass ${job.status}` });
    }
  }
  if (p && p.stage === "stills" && p.stillsJobId) {
    const job = await prisma.agentJob.findUnique({ where: { id: p.stillsJobId } });
    if (job && job.status === "done") {
      const rel = `edit/stills/${job.id}`;
      const mf = path.join(ensureProjectDir(project.id), rel, "manifest.json");
      const m = existsSync(mf) ? (JSON.parse(readFileSync(mf, "utf8")) as { stills: (Omit<Still, "file"> & { file: string })[] }) : null;
      if (!m) await save({ ...p, stage: "style_ready", error: "The stills job finished without a manifest" });
      else {
        const stills = m.stills.map((s) => ({ ...s, file: `${rel}/${s.file}` }));
        if (p.checkId && p.checkRound >= 1) {
          // these are the stills after the check's fix round: show them with the report
          await finishCheck(project, p.checkId);
          await save({ ...p, stage: "stills_review", stills, error: null });
        } else {
          // R5: a fresh check before the stills are shown
          const tlFile = path.join(ensureProjectDir(project.id), rel, "timeline.json");
          const tl = existsSync(tlFile) ? (JSON.parse(readFileSync(tlFile, "utf8")) as Timeline) : null;
          try {
            const rc = await startCheck(project, "stills", job.id, { timeline: tl, stills });
            await save({ ...p, stage: "check", stills, checkId: rc.id, checkRound: 0, error: null });
          } catch (err) {
            await save({ ...p, stage: "stills_review", stills, error: `Rule check skipped: ${(err as Error).message}` });
          }
        }
      }
    } else if (job && (job.status === "failed" || job.status === "cancelled")) {
      await save({ ...p, stage: p.style ? "style_ready" : "cut_approved", error: job.error ?? `Stills ${job.status}` });
    }
  }
  if (p && p.stage === "check" && p.checkId) {
    const cur: Pipeline = p;
    const rc = await prisma.ruleCheck.findUnique({ where: { id: cur.checkId! } });
    if (!rc) await save({ ...cur, stage: "stills_review" });
    else if (rc.status === "checking") {
      const r = await takeReport(project, rc);
      if (r.state === "failed") {
        await failCheck(project, rc.id, r.note);
        await save({ ...cur, stage: "stills_review" });
      } else if (r.state === "done" && !r.toFix.length) {
        await finishCheck(project, rc.id);
        await save({ ...cur, stage: "stills_review" });
      } else if (r.state === "done") {
        // one style revision from the project's session fixes what failed, then the stills are rendered again
        const tlFile = path.join(ensureProjectDir(project.id), "edit", "stills", rc.subjectJobId, "timeline.json");
        const tl = existsSync(tlFile) ? (JSON.parse(readFileSync(tlFile, "utf8")) as Timeline) : null;
        const fresh = (await prisma.project.findUnique({ where: { id: project.id } }))!;
        if (!tl) {
          await finishCheck(project, rc.id, { fixFailed: "the checked timeline is missing, so nothing was fixed" });
          await save({ ...cur, stage: "stills_review" });
        } else {
          try {
            const job = await startStyle(fresh, { timeline: tl, revise: true, checkFix: { checkId: rc.id, brief: fixBrief(rc.id, r.report, ensureProjectDir(project.id)) } });
            await prisma.ruleCheck.update({ where: { id: rc.id }, data: { status: "fixing", fixJobId: job.id } });
            p = getPipeline((await prisma.project.findUnique({ where: { id: project.id } }))!);
          } catch (err) {
            await finishCheck(project, rc.id, { fixFailed: (err as Error).message });
            await save({ ...cur, stage: "stills_review" });
          }
        }
      }
    } else await save({ ...cur, stage: "stills_review" });
  }
  return p;
}

/** Claude's conflict list wins for topics it reports; ReelSmith's precomputed ones fill the rest. */
function mergeConflicts(pre: Conflict[], fromClaude: Conflict[]) {
  const seen = new Set(fromClaude.map((c) => c.topic.toLowerCase()));
  return [...fromClaude, ...pre.filter((c) => !seen.has(c.topic.toLowerCase()))];
}
