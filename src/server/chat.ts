import "server-only";
// Prompt-driven editing: the chat panel on every project. One message -> the workflow steps it needs:
//   - quick chips that are deterministic run without Claude (cut pauses / captions in the editor, stills, render);
//   - a message that is only timestamped fixes ("Around 0:18, ...") on a cut under review is ONE plan revision;
//   - anything else is a short "chat" turn (light) that writes chat/<job>.json = {reply, actions}; ReelSmith then runs
//     the actions: edit ops (applied by the editor as one undoable step), the spoken cut (stage 1), the style pass +
//     stills (stage 2), render (only after the stills are approved), a creator teardown.
// Every Claude step resumes the project's one session (projectSession), so later instructions build on earlier ones.
// Feedback (typed, a voice note, notes on the cut / stills / a render) is turned into taste-checklist rules in the user's words
// before anything changes (src/server/rules.ts, R2); a note that contradicts a rule becomes a question (R6).
import crypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ChatMessage, Prisma, Project } from "@prisma/client";
import { fwd } from "@/agent/config";
import { chatResultSchema, type ChatAction, type ChatResult, type PlanMode } from "@/agent/schemas";
import { describeForAi, type AiOp } from "@/lib/timeline/ai";
import type { Timeline } from "@/lib/timeline/types";
import { fixesBlock, parseFixes, type Fix } from "@/lib/chat/fixes";
import { isOnlyLookCommand, parseLookCommand } from "@/lib/timeline/looks-chat";
import { createJob, ensureProjectDir, jobDTO, localMediaPath, projectSession } from "./agent";
import { AI_EDIT_OPS, resolveAiEdit } from "./aiedit";
import { startTeardown } from "./creators";
import { prisma } from "./db";
import { HttpError } from "./http";
import { isPlanMode, MODES, revisePlan, startPlan, syncPlanStatus, type ModeInputs } from "./modes";
import { ensurePipeline, getPipeline, renderGate, startStills, startStyle, STAGE_LABEL, syncPipeline } from "./pipeline";
import { queueRender } from "./renders";
import { listCreatorHandles, normHandle, readCreatorStyle, styleLayers } from "./style";
import { absorbNotes, notesBlock, rulesAddedIn, type NoteSource, type RuleConflictData, type RuleNotesData } from "./rules";
import type { CheckSummary } from "./rulecheck";
import { assertTimeline } from "./validate";

export const CHIPS = ["cut_pauses", "captions", "creator_style", "stills", "render"] as const;
export type Chip = (typeof CHIPS)[number];

export interface StepInfo {
  type: ChatAction["type"] | "note";
  label: string;
  jobId?: string | null;
  note?: string;
}
export interface ChatData {
  fixes?: Fix[];
  chip?: Chip;
  steps?: StepInfo[];
  ops?: (AiOp & { why?: string })[]; // edit ops for the editor to apply
  opsSummary?: string;
  applied?: boolean;
  dismissed?: boolean;
  ruleProposal?: { rule: string; topic: string; saved?: string | null };
  /** where the user's message came from (typed chat, a voice note, notes on the cut / stills / a render) */
  source?: NoteSource;
  ruleNotes?: RuleNotesData; // notes filed as rules before the change (R2)
  ruleConflict?: RuleConflictData; // a note contradicts a rule: which wins? (R6)
  ruleCheck?: CheckSummary; // the fresh checker's report on a draft (R5)
  renderDone?: { renderId: string; version: string; rules: { id: string; title: string; words: string }[] }; // R7
  voice?: { jobId: string; consumed?: boolean };
}

const BUILT = ["ready", "rendered"];
const r2 = (n: number) => Math.round(n * 100) / 100;

async function say(project: Project, role: "user" | "assistant" | "step" | "system", text: string, data: ChatData = {}, jobId: string | null = null) {
  return prisma.chatMessage.create({
    data: { projectId: project.id, userId: project.userId, role, text, jobId, data: data as unknown as Prisma.InputJsonValue },
  });
}

async function currentTimeline(project: Project, sent: unknown): Promise<Timeline | null> {
  if (sent) {
    assertTimeline(sent);
    return sent as Timeline;
  }
  const t = await prisma.timeline.findUnique({ where: { projectId: project.id } });
  return t ? (t.json as unknown as Timeline) : null;
}

// ---------------------------------------------------------------- context for prompts

/** Reel time -> source of each piece of a plan under review, so "Around 0:18" can be found in the cut. */
export function planReelMap(mode: string, plan: unknown): string {
  if (!plan || typeof plan !== "object") return "";
  const p = plan as Record<string, unknown>;
  const rows: string[] = [];
  if (mode === "talking_head") {
    let t = 0;
    for (const [i, s] of ((p.segments as { sourceId: string; in: number; out: number; text: string; include?: boolean }[]) ?? []).entries()) {
      if (s.include === false) continue;
      const d = s.out - s.in;
      rows.push(`reel ${r2(t)}-${r2(t + d)} = segments[${i}] ${s.sourceId} ${r2(s.in)}-${r2(s.out)}: "${s.text.slice(0, 80)}"`);
      t += d;
    }
  } else if (mode === "best_take") {
    let t = 0;
    for (const [i, l] of ((p.lines as { text: string; chosen: { sourceId: string; in: number; out: number } }[]) ?? []).entries()) {
      const d = l.chosen.out - l.chosen.in;
      rows.push(`reel ${r2(t)}-${r2(t + d)} = lines[${i}] ${l.chosen.sourceId} ${r2(l.chosen.in)}-${r2(l.chosen.out)}: "${l.text.slice(0, 80)}"`);
      t += d;
    }
  } else if (mode === "voiceover_broll") {
    for (const [i, s] of ((p.segments as { start: number; end: number; text: string; sourceId: string }[]) ?? []).entries())
      rows.push(`reel ${r2(s.start)}-${r2(s.end)} = segments[${i}] ${s.sourceId}: "${s.text.slice(0, 80)}"`);
  } else if (mode === "music") {
    for (const [i, s] of ((p.shots as { start: number; end: number; sourceId: string; in: number; out: number }[]) ?? []).entries())
      rows.push(`reel ${r2(s.start)}-${r2(s.end)} = shots[${i}] ${s.sourceId} ${r2(s.in)}-${r2(s.out)}`);
  }
  return rows.join("\n");
}

function inputsBlock(project: Project, assets: { id: string; type: string; url: string; name: string; duration: number | null }[]) {
  const inputs = (project.inputs ?? null) as unknown as ModeInputs | null;
  if (!inputs) return "";
  const role = new Map<string, string>();
  for (const [r, ids] of Object.entries(inputs.assets ?? {})) for (const id of ids) role.set(id, r);
  return assets.map((a) => `- ${a.id} | ${role.get(a.id) ?? "?"} | ${a.type} | ${fwd(localMediaPath(a.url) ?? "(not local)")} | ${a.duration?.toFixed(1) ?? "?"}s | "${a.name}"`).join("\n");
}

function chatPrompt(o: {
  project: Project;
  text: string;
  fixes: Fix[];
  outFile: string;
  dir: string;
  tlFile: string | null;
  inputs: string;
  reelMap: string;
  creators: string[];
  stage: string;
  notes: string;
}) {
  const { project: p } = o;
  const planMode = isPlanMode(p.mode);
  return `## ReelSmith chat · project "${p.title}" (${p.aspect})
Mode: ${planMode ? `${MODES[p.mode as PlanMode].label} (${p.mode})` : `${p.mode} (voice-first)`} · status: ${p.status} · workflow: ${o.stage}
Project folder: ${o.dir}
${o.inputs ? `\n## Inputs (asset id | role | type | file | duration | name)\n${o.inputs}\n` : ""}${o.tlFile ? `\nCurrent timeline (what the user sees in the editor: clip ids, times, text, what is said, captions, fx, maxZoom): ${o.tlFile}\n` : "\nNo timeline yet (the spoken cut isn't approved).\n"}${o.reelMap ? `\n## The cut under review (reel time -> plan entry)\n${o.reelMap}\n` : ""}
Creator profiles available: ${o.creators.length ? o.creators.map((h) => `@${h}`).join(", ") : "none"}
Taste checklist and gotchas: in your instructions (active rules only; Type "taste" rules beat creator styles and the brand kit).

## The user's message
"""
${o.text}
"""
${o.notes}${o.fixes.length ? `\nTimestamped fixes in it (reel seconds of the ${o.reelMap ? "cut under review" : "current timeline"}; apply them ALL in ONE action = one rebuild):\n${fixesBlock(o.fixes)}\n` : ""}
## Decide the workflow steps and write ${o.outFile}
{"reply": "1-3 sentences to the user: what will happen", "actions": [ ... ]}   Actions, in the order to run them:
- {"type": "edit", "ops": [...]}: change the current timeline now (small fixes, captions on/off/style, zooms, text, transitions,
  cutting pauses). Only when a timeline exists. Ops below.
- {"type": "cut", "brief": "...", "mode": null}: stage 1, the SPOKEN CUT only (last take wins, pauses and fillers removed):
  start it, or revise the cut under review with the brief (put every timestamped fix in the brief). After the cut is built,
  starting it again rebuilds the timeline from scratch: only when the user clearly asks to re-cut.
- {"type": "style", "creator": "handle" | null, "brief": "..."}: stage 2, the style pass (creator style.json + taste rules + brand kit)
  with key stills to approve. Before the cut is approved it is queued and runs automatically after approval.
- {"type": "stills"}: render the key stills again (no other change).
- {"type": "render", "quality": "1080p"}: only when the user asks to render/export. ReelSmith refuses until the stills are approved.
- {"type": "teardown", "handle": "...", "platform": "tiktok" | "youtube", "urls": null}: a creator the user names (@handle) has no
  profile yet: measure 5 of their videos first (then also add the style action: it waits for the profile).
Lasting preferences are not an action: they go in the notes file above, and ReelSmith files them before running the actions.
Rules: do the cheapest thing that does what was asked (a small change = edit ops, not a new cut or style pass). Several timestamped
fixes = ONE action. A note about one moment is fixed at its cause, everywhere in the video (R4): say so in the ops / brief.
A note that contradicts an active rule: leave that part out of the actions (ReelSmith asks the user first). Don't do the cut or style work in this turn and don't touch media: only decide (ReelSmith runs the steps as the
next turns of this same conversation). Nothing to do = no actions and say why. Write only ${o.outFile}.

## Edit ops
${AI_EDIT_OPS}`;
}

// ---------------------------------------------------------------- post

export async function postChat(o: {
  project: Project;
  text: string;
  chip?: Chip | null;
  creator?: string | null;
  timeline?: unknown;
  plan?: unknown;
  /** where the message came from (default: typed in the chat) */
  source?: NoteSource;
  /** the notes in it were already filed (e.g. a note the user just let win a conflict): don't file them again */
  noNotes?: boolean;
}) {
  const { project } = o;
  await settleChat(project);
  const text = o.text.trim();
  const { fixes } = parseFixes(text);
  const source = o.source ?? "chat";
  const user = await say(project, "user", text, { fixes: fixes.length ? fixes : undefined, chip: o.chip ?? undefined, source });

  // the user's table edits on the plan screen are saved with the message (like "Send feedback")
  if (o.plan && project.status === "review") await prisma.project.update({ where: { id: project.id }, data: { plan: o.plan as Prisma.InputJsonValue } });
  const fresh = (await prisma.project.findUnique({ where: { id: project.id } }))!;

  if (o.chip) return { user, ...(await runChip(fresh, o.chip, { timeline: o.timeline, creator: o.creator ?? null })) };

  // only a look switch ("cool girl when I say X, bold everywhere else") on a built edit: the ops directly, no Claude turn
  if (BUILT.includes(fresh.status) && !fixes.length && isOnlyLookCommand(text)) {
    const cmd = parseLookCommand(text);
    if (cmd) return { user, messages: [await say(fresh, "assistant", `${cmd.summary}. The looks rebuild in the editor (speaker cut-outs run in the background).`, { ops: cmd.ops, opsSummary: cmd.summary, applied: false })] };
  }
  // a cut under review + nothing but timestamped fixes -> one plan revision, no extra chat turn
  const { rest } = parseFixes(text);
  if (fixes.length && !rest && fresh.status === "review" && isPlanMode(fresh.mode)) {
    const job = await reviseCut(fresh, "", fixes, { notes: !o.noNotes });
    const step = await say(fresh, "step", `Revising the cut: ${fixes.length} timestamped fix${fixes.length > 1 ? "es" : ""} in one pass`, { steps: [{ type: "cut", label: "Revise the cut", jobId: job.id }] }, job.id);
    return { user, messages: [step] };
  }
  return { user, ...(await startChatTurn(fresh, text, fixes, o.timeline, { source, noNotes: o.noNotes })) };
}

async function startChatTurn(project: Project, text: string, fixes: Fix[], sent: unknown, n: { source?: NoteSource; noNotes?: boolean } = {}) {
  const dir = ensureProjectDir(project.id);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  mkdirSync(path.join(dir, "chat"), { recursive: true });
  const tl = BUILT.includes(project.status) ? await currentTimeline(project, sent) : null;
  let tlFile: string | null = null;
  if (tl) {
    tlFile = path.join(dir, "chat", `${id}.timeline.json`);
    writeFileSync(tlFile, JSON.stringify(describeForAi(tl), null, 1));
    writeFileSync(path.join(dir, "jobs", `${id}.base.json`), JSON.stringify(tl));
  }
  const inputs = (project.inputs ?? null) as unknown as ModeInputs | null;
  const assets = inputs ? await prisma.mediaAsset.findMany({ where: { userId: project.userId, id: { in: Object.values(inputs.assets ?? {}).flat() } } }) : [];
  const pl = getPipeline(project);
  const outFile = `chat/${id}.json`;
  const job = await createJob({
    id,
    userId: project.userId,
    projectId: project.id,
    kind: "chat",
    title: `Chat: ${text.replace(/\s+/g, " ").slice(0, 70)}`,
    prompt: chatPrompt({
      project,
      text,
      fixes,
      outFile: `${fwd(dir)}/${outFile}`,
      dir: fwd(dir),
      tlFile: tlFile ? fwd(tlFile) : null,
      inputs: inputsBlock(project, assets),
      reelMap: project.status === "review" ? planReelMap(project.mode, project.plan) : "",
      creators: listCreatorHandles().map((c) => c.handle),
      stage: pl ? STAGE_LABEL[pl.stage] : project.status === "review" ? "reviewing the cut" : "not started",
      notes: n.noNotes ? "" : notesBlock(dir, id, n.source ?? "chat"),
    }),
    resumeSessionId: await projectSession(project.id),
    outputFile: outFile,
    schema: "chat",
    timeoutSec: 10 * 60,
  });
  return { job: jobDTO(job), messages: [] as ChatMessage[] };
}

// ---------------------------------------------------------------- quick chips

async function runChip(project: Project, chip: Chip, o: { timeline: unknown; creator: string | null }): Promise<{ messages: ChatMessage[]; job?: ReturnType<typeof jobDTO> }> {
  const built = BUILT.includes(project.status);
  if (chip === "cut_pauses") {
    if (built) {
      const ops: AiOp[] = [{ op: "cut_pauses", minGap: 0.35 }];
      return { messages: [await say(project, "assistant", "Cutting every pause longer than 0.35 s (one undoable step).", { ops, opsSummary: "Cut pauses", applied: false })] };
    }
    if (project.status === "review" && isPlanMode(project.mode)) {
      const job = await reviseCut(project, "Cut every pause longer than 0.3 s and every filler (um, uh, like, you know); last take wins on repeated lines.", []);
      return { messages: [await say(project, "step", "Tightening the cut: pauses and fillers", { steps: [{ type: "cut", label: "Revise the cut", jobId: job.id }] }, job.id)] };
    }
    return { messages: [await say(project, "system", "Wait until the cut is ready to review.")] };
  }
  if (chip === "captions") {
    if (!built) return { messages: [await say(project, "system", "Captions go on in stage 2, after you approve the spoken cut.")] };
    const layers = await styleLayers(project.userId, getPipeline(project)?.creator ?? null);
    const style = layers.topics.find((t) => t.key === "captions.style")!;
    if (style.winner === "taste") {
      // a taste rule decides the captions: let Claude read it
      return startChatTurn(project, `Add captions following my taste rule(s) ${style.rule}.`, [], o.timeline, { noNotes: true });
    }
    const s = ["bold", "karaoke", "minimal", "boxed"].includes(style.value) ? (style.value as AiOp["captionStyle"]) : "bold";
    const ops: AiOp[] = [{ op: "set_captions", enabled: true, captionStyle: s }];
    return { messages: [await say(project, "assistant", `Captions on, style “${s}” (${style.winner === "default" ? "default" : `from the ${style.winner === "brand" ? "brand kit" : "creator style"}`}).`, { ops, opsSummary: "Add captions", applied: false })] };
  }
  if (chip === "creator_style") {
    const creator = o.creator ? normHandle(o.creator) : (getPipeline(project)?.creator ?? null);
    if (creator && !readCreatorStyle(creator)) return { messages: [await say(project, "system", `@${creator} has no style profile yet: run a creator teardown first.`)] };
    return { messages: [await runAction(project, { type: "style", creator, brief: "" }, { timeline: await currentTimeline(project, o.timeline), fixes: [] })] };
  }
  if (chip === "stills") return { messages: [await runAction(project, { type: "stills" }, { timeline: await currentTimeline(project, o.timeline), fixes: [] })] };
  return { messages: [await runAction(project, { type: "render", quality: "1080p" }, { timeline: await currentTimeline(project, o.timeline), fixes: [] })] };
}

// ---------------------------------------------------------------- actions

async function reviseCut(project: Project, brief: string, fixes: Fix[], o: { notes?: boolean } = {}) {
  const map = planReelMap(project.mode, project.plan);
  const feedback = [
    brief,
    fixes.length ? `Timestamped fixes (reel seconds of the cut; apply ALL of them in this one revision):\n${fixesBlock(fixes)}` : "",
    fixes.length && map ? `Reel time -> plan entry:\n${map}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  await ensurePipeline(project, { stage: "cut" });
  return revisePlan(project, feedback, project.plan, { notes: o.notes });
}

async function runAction(project: Project, a: ChatAction, ctx: { timeline: Timeline | null; fixes: Fix[]; baseFile?: string }): Promise<ChatMessage> {
  const step = (label: string, jobId: string | null, note?: string) => say(project, "step", label, { steps: [{ type: a.type, label, jobId, note }] }, jobId);
  const note = (text: string) => say(project, "system", text);
  try {
    switch (a.type) {
      case "edit": {
        if (!ctx.timeline) return note("There is no timeline to edit yet (approve the cut first).");
        const res = await resolveAiEdit(project.userId, ctx.timeline, { summary: a.why ?? "Edit", ops: a.ops });
        return say(project, "assistant", res.summary, { ops: res.ops, opsSummary: res.summary, applied: false });
      }
      case "cut": {
        if (!isPlanMode(project.mode)) {
          if (!ctx.timeline) return note("Nothing to cut yet.");
          return say(project, "assistant", "Cutting the pauses on the voice track.", { ops: [{ op: "cut_pauses", minGap: 0.35 }], opsSummary: "Cut pauses", applied: false });
        }
        if (project.status === "planning") return note("Claude is already cutting: your note is in the chat history, send it again once the cut is ready if it isn't covered.");
        if (project.status === "review") return step("Revising the spoken cut", (await reviseCut(project, a.brief, ctx.fixes)).id);
        // not planned yet, failed, or a re-cut of a built project: a fresh plan in the same session
        const inputs = (project.inputs ?? {}) as unknown as ModeInputs;
        const notes = [inputs.notes, a.brief].filter(Boolean).join("\n");
        await prisma.project.update({ where: { id: project.id }, data: { inputs: { ...inputs, notes } as unknown as Prisma.InputJsonValue } });
        const p2 = (await prisma.project.findUnique({ where: { id: project.id } }))!;
        await ensurePipeline(p2, { stage: "cut", styleJobId: null, style: null, stills: [], approvedHash: null });
        const job = await startPlan(p2);
        return step(BUILT.includes(project.status) ? "Re-cutting the speech (stage 1): the timeline is rebuilt when you approve it" : "Cutting the speech (stage 1)", job.id);
      }
      case "style": {
        const creator = a.creator ? normHandle(a.creator) : null;
        const pl = await ensurePipeline(project);
        const missing = creator && !readCreatorStyle(creator);
        if (!BUILT.includes(project.status) || missing) {
          await ensurePipeline(project, { pendingStyle: true, creator: creator ?? pl.creator, brief: [pl.brief, a.brief].filter(Boolean).join("\n") });
          return note(
            missing
              ? `The style pass with @${creator} waits for their teardown to finish${BUILT.includes(project.status) ? "" : " and for you to approve the cut"}.`
              : "The style pass is queued: it starts as soon as you approve the spoken cut (stage 1).",
          );
        }
        if (!ctx.timeline) return note("No timeline to style yet.");
        const job = await startStyle(project, { timeline: ctx.timeline, creator, brief: a.brief, fixes: ctx.fixes, revise: Boolean(pl.style?.applied) });
        return step(`Style pass${creator ? ` · @${creator}` : ""} (stage 2): ops + key stills`, job.id);
      }
      case "stills": {
        if (!ctx.timeline || !BUILT.includes(project.status)) return note("Stills come after the cut is approved.");
        const job = await startStills(project, ctx.timeline, getPipeline(project)?.style?.picks);
        return step("Rendering key stills", job.id);
      }
      case "render": {
        const gate = renderGate(project, ctx.timeline);
        if (!gate.ok) return note(`Not rendering yet: ${gate.reason}`);
        const { render, changedSinceStills } = await queueRender(project, project.userId, { quality: a.quality ?? "1080p", json: ctx.timeline ?? undefined });
        return say(project, "step", `Rendering ${render.quality}${changedSinceStills ? " (the timeline changed since you approved the stills)" : ""}`, {
          steps: [{ type: "render", label: render.version.name, note: render.id }],
        });
      }
      case "teardown": {
        const r = await startTeardown({ userId: project.userId, handle: a.handle, platform: a.platform ?? null, urls: a.urls ?? null, projectId: project.id });
        return step(`Creator teardown @${r.handle}: measuring 5 videos, then the style analysis`, r.analysis.id);
      }
      case "taste_rule":
        return say(project, "assistant", `Save this as a taste rule? “${a.rule}”`, { ruleProposal: { rule: a.rule, topic: a.topic } });
    }
  } catch (err) {
    return note(`${a.type}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- settle

/** Finished chat turns -> Claude's reply + the actions it asked for. Idempotent (one reply per job). */
export async function settleChat(project: Project) {
  const jobs = await prisma.agentJob.findMany({
    where: { projectId: project.id, kind: "chat", status: { in: ["done", "failed", "cancelled"] } },
    orderBy: { createdAt: "asc" },
  });
  if (!jobs.length) return;
  const answered = new Set(
    (await prisma.chatMessage.findMany({ where: { projectId: project.id, jobId: { in: jobs.map((j) => j.id) }, role: { in: ["assistant", "system"] } }, select: { jobId: true } })).map((m) => m.jobId),
  );
  for (const job of jobs) {
    if (answered.has(job.id)) continue;
    // two polls at once (the editor and the plan screen, or two tabs) must not run a turn's actions twice: claim it
    if (!claimSettle(project.id, job.id)) continue;
    if (job.status !== "done") {
      await say(project, "system", job.status === "cancelled" ? "Cancelled." : `Claude couldn't finish: ${job.error ?? "unknown error"}`, {}, job.id);
      continue;
    }
    const dir = ensureProjectDir(project.id);
    const file = path.join(dir, job.outputFile ?? "");
    const parsed = chatResultSchema.safeParse(existsSync(file) ? JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) : null);
    if (!parsed.success) {
      await say(project, "system", "Claude's answer was missing or invalid.", {}, job.id);
      continue;
    }
    const res: ChatResult = parsed.data;
    const user = await prisma.chatMessage.findFirst({ where: { projectId: project.id, role: "user", createdAt: { lte: job.createdAt } }, orderBy: { createdAt: "desc" } });
    const fixes = ((user?.data as ChatData | null)?.fixes ?? []) as Fix[];
    // R2: the notes become rules before any action changes the edit
    await absorbNotes(project, job.id, (user?.data as ChatData | null)?.source ?? "chat");
    const basePath = path.join(dir, "jobs", `${job.id}.base.json`);
    const timeline = existsSync(basePath) ? (JSON.parse(readFileSync(basePath, "utf8")) as Timeline) : null;
    await say(project, "assistant", res.reply, { steps: res.actions.map((a) => ({ type: a.type, label: a.type })) }, job.id);
    let p = (await prisma.project.findUnique({ where: { id: project.id } }))!;
    for (const a of res.actions) {
      await runAction(p, a, { timeline, fixes });
      p = (await prisma.project.findUnique({ where: { id: project.id } }))!;
    }
  }
  // a chat turn that failed after writing its notes file: the notes still become rules
  for (const job of jobs) if (job.status !== "done") await absorbNotes(project, job.id, "chat");
  await settleVoiceNotes(project);
  await announceRenders(project);
}

/** Exclusive create of chat/<job>.settled: true for the one caller that may settle this chat turn. */
function claimSettle(projectId: string, jobId: string) {
  try {
    writeFileSync(path.join(ensureProjectDir(projectId), "chat", `${jobId}.settled`), new Date().toISOString(), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** Voice notes (chat mic): once transcribed locally, the words go through the chat like a typed message. */
async function settleVoiceNotes(project: Project) {
  const steps = await prisma.chatMessage.findMany({ where: { projectId: project.id, role: "step", data: { path: ["voice", "consumed"], equals: false } } });
  for (const m of steps) {
    const v = (m.data as ChatData).voice!;
    const job = await prisma.agentJob.findUnique({ where: { id: v.jobId } });
    if (!job || job.status === "queued" || job.status === "running") continue;
    await prisma.chatMessage.update({ where: { id: m.id }, data: { data: { ...(m.data as object), voice: { ...v, consumed: true } } as Prisma.InputJsonValue } });
    const f = path.join(ensureProjectDir(project.id), "chat", "voice", `${v.jobId}.json`);
    const text = job.status === "done" && existsSync(f) ? String((JSON.parse(readFileSync(f, "utf8")) as { text?: string }).text ?? "").trim() : "";
    if (!text) {
      await say(project, "system", job.status === "done" ? "I couldn't hear any words in that voice note." : `The voice note couldn't be transcribed: ${job.error ?? job.status}`);
      continue;
    }
    const fresh = (await prisma.project.findUnique({ where: { id: project.id } }))!;
    const { fixes } = parseFixes(text);
    await say(fresh, "user", text, { fixes: fixes.length ? fixes : undefined, source: "voice" });
    await startChatTurn(fresh, text, fixes, undefined, { source: "voice" });
  }
}

/** Taste checklist R7: when a video is finished, show the rules this project added. Announces the latest finished render once. */
async function announceRenders(project: Project) {
  const r = await prisma.renderJob.findFirst({
    where: { projectId: project.id, status: "done", finishedAt: { gte: new Date(Date.now() - 12 * 3600_000) } },
    orderBy: { finishedAt: "desc" },
    include: { version: { select: { name: true } } },
  });
  if (!r) return;
  const seen = await prisma.chatMessage.findFirst({ where: { projectId: project.id, data: { path: ["renderDone", "renderId"], equals: r.id } } });
  if (seen) return;
  const rules = (await rulesAddedIn(project.id)).filter((x) => x.status !== "deleted");
  const text = rules.length
    ? `${r.version.name} is finished. Rules added while making this video: ${rules.map((x) => `${x.id} “${x.title}”`).join(", ")}.`
    : `${r.version.name} is finished. No new rules were added while making this video.`;
  await say(project, "assistant", text, { renderDone: { renderId: r.id, version: r.version.name, rules: rules.map(({ id, title, words }) => ({ id, title, words })) } });
}

// ---------------------------------------------------------------- state

/** Everything the chat panel shows: messages (with their jobs), the workflow stage, running jobs, creators. */
export async function chatState(project: Project) {
  if (isPlanMode(project.mode)) project = await syncPlanStatus(project); // planning -> review before the stage is read
  await settleChat(project);
  const pipeline = await syncPipeline((await prisma.project.findUnique({ where: { id: project.id } }))!);
  const p = (await prisma.project.findUnique({ where: { id: project.id } }))!;
  const messages = await prisma.chatMessage.findMany({ where: { projectId: project.id }, orderBy: { createdAt: "asc" }, take: 300 });
  const jobIds = [...new Set(messages.map((m) => m.jobId).filter(Boolean) as string[])];
  const jobs = await prisma.agentJob.findMany({ where: { OR: [{ id: { in: jobIds } }, { projectId: project.id, status: { in: ["queued", "running"] } }] }, orderBy: { createdAt: "asc" } });
  return {
    project: { id: p.id, status: p.status, mode: p.mode, title: p.title },
    pipeline,
    stageLabel: p.status === "draft" ? "Stage 1 · Tell Claude what to make: your first message starts the spoken cut" : pipeline ? STAGE_LABEL[pipeline.stage] : null,
    messages: messages.map((m) => ({ id: m.id, role: m.role, text: m.text, jobId: m.jobId, data: m.data as ChatData | null, createdAt: m.createdAt.toISOString() })),
    jobs: jobs.map(jobDTO),
    creators: listCreatorHandles().map((c) => c.handle),
  };
}

/** The editor applied (or dismissed) a message's ops, or a proposed taste rule was saved / dismissed. */
export async function markMessage(project: Project, messageId: string, patch: { applied?: boolean; dismissed?: boolean; ruleSaved?: string | null }) {
  const m = await prisma.chatMessage.findFirst({ where: { id: messageId, projectId: project.id } });
  if (!m) throw new HttpError(404, "Message not found");
  const cur = (m.data as ChatData | null) ?? {};
  const data: ChatData = {
    ...cur,
    ...(patch.applied !== undefined ? { applied: patch.applied } : {}),
    ...(patch.dismissed ? { dismissed: true } : {}),
    ...(patch.ruleSaved !== undefined && cur.ruleProposal ? { ruleProposal: { ...cur.ruleProposal, saved: patch.ruleSaved } } : {}),
  };
  await prisma.chatMessage.update({ where: { id: m.id }, data: { data: data as unknown as Prisma.InputJsonValue } });
}
