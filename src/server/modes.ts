import "server-only";
// Edit modes. Each mode is: inputs (new-edit page) -> a Claude "plan" job that transcribes locally and analyses
// the footage with the video-use / edit-reel tools and writes plan.json -> the user reviews and edits the plan
// (or sends feedback, which resumes the same Claude session) -> approve: this module builds ordinary editable
// timeline tracks from the plan, so render, Enhance and the self-checks work the same as for any project.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { MediaAsset, Prisma, Project } from "@prisma/client";
import { appDir, creatorDir, fwd, studioDir, workerPython } from "@/agent/config";
import {
  PLAN_SCHEMAS,
  type AutoClipPlan,
  type BestTakePlan,
  type MusicPlan,
  type PlanMode,
  type TalkingHeadPlan,
  type VoiceoverPlan,
  type SchemaName,
} from "@/agent/schemas";
import { energize, timelineBeats, type TrackBeats } from "@/lib/timeline/beatfx";
import { placement } from "@/lib/timeline/derive";
import { emptyTimeline, newAudioClip, newTextClip, newVisualClip } from "@/lib/timeline/factory";
import { DESIGN_SIZE, type Aspect, type AudioClip, type Enhance, type Filters, type Grade, type TextClip, type Timeline, type Transform, type VisualClip, type Word } from "@/lib/timeline/types";
import { setBackground } from "@/lib/timeline/matte";
import { createJob, ensureProjectDir, localMediaPath, projectSession } from "./agent";
import { queueMattesFor } from "./matte";
import { prisma } from "./db";
import { HttpError } from "./http";
import { sourceFps } from "./probe";
import { localPath, publicUrl } from "./storage";
import { withClientLook } from "./looks";
import { absorbNotes, notesBlock } from "./rules";
import { failCheck, finishCheck, fixBrief, startCheck, takeReport } from "./rulecheck";

export const MODES: Record<PlanMode, { label: string; roles: Record<string, { label: string; many: boolean; required: boolean }> }> = {
  music: {
    label: "Music edit",
    roles: { clips: { label: "Clips", many: true, required: true }, music: { label: "Track", many: false, required: false } },
  },
  talking_head: {
    label: "Talking head",
    roles: { clips: { label: "Clips of you talking", many: true, required: true }, background: { label: "Background image", many: false, required: false } },
  },
  best_take: { label: "Best take", roles: { takes: { label: "Takes", many: true, required: true } } },
  voiceover_broll: {
    label: "Voiceover + b-roll",
    roles: {
      voice: { label: "Voice recording", many: false, required: true },
      broll: { label: "B-roll", many: true, required: true },
      music: { label: "Background music", many: false, required: false },
      background: { label: "Background image", many: false, required: false },
    },
  },
  auto_clip: { label: "Auto-clip", roles: { source: { label: "Long video", many: false, required: true } } },
};
export const isPlanMode = (m: string): m is PlanMode => m in PLAN_SCHEMAS;

export interface ModeInputs {
  assets: Record<string, string[]>; // role -> asset ids
  script?: string; // best take: the script (optional)
  musicUrl?: string; // music edit: a /reel/ or other link to fetch the sound from (yt-dlp)
  notes?: string; // free-text brief for Claude
  faceCutbacks?: boolean; // voiceover: cut back to the face for key lines (voice must be a video)
  count?: number; // auto-clip: how many shorts
  minSec?: number;
  maxSec?: number;
  grade?: Grade | null; // talking head / best take: a look applied to every clip on approve (Cinematic Warm)
  creator?: string | null; // a creator profile (creator-profiles/<handle>): guides the plan; stage 2 applies the rest
}

const SAFE_TOP = 250 / 1920;
const SAFE_BOTTOM = 1 - 400 / 1920;

// ---------------------------------------------------------------- prompts

function inputsTable(assets: MediaAsset[], roleOf: Map<string, string>) {
  return assets
    .map((a) => {
      const p = localMediaPath(a.url);
      return `- ${a.id} | ${roleOf.get(a.id)} | ${a.type} | ${p ? fwd(p) : "(not local)"} | ${a.duration ? `${a.duration.toFixed(1)}s` : "?"} | ${a.width ?? "?"}x${a.height ?? "?"} | "${a.name}"`;
    })
    .join("\n");
}

function toolsBlock(dir: string) {
  const s = fwd(studioDir());
  const er = `${s}/.claude/skills/edit-reel/scripts`;
  const vu = `${s}/.claude/skills/video-use/helpers`;
  return `## Tools (all local and free; never call a paid API)
- PRECOMPUTED before you started (do not run these again, do not look for scripts, do not try alternatives):
  ${dir}/edit/prep.json (per file: duration, size, fps, lowRes, hasAudio, speech, words, language; plus step timings),
  ${dir}/edit/transcript.json ([{clip: file name, language, words: [{word, start, end, prob}]}]) for the clips with speech,
  ${dir}/edit/transcript.txt (phrases), and ${dir}/edit/music.json (beats, if a track was given).
  Clips marked speech:false have no words worth using: they are silent or only background sound.
  If a file you need is missing from prep.json, say so in "summary" and skip it. Do not transcribe it yourself.
- Cut cleaning for speech: python ${er}/speech_cuts.py ${dir}/edit/transcript.json <file name> --src-dir <its folder> --max-gap 0.3 --phrases [--drop i-j,...] --out ${dir}/edit/cuts_<n>.json
  Removes fillers (um, uh, comma-delimited "like", "you know"/"I mean" with --phrases), stutters and pauses over --max-gap,
  and snaps every cut to the quietest 10 ms next to the word boundary (never mid-word). It prints the word table (index i).
- Look at footage: python ${er}/contact_sheet.py <video> ${dir}/edit/verify/<name>.png --n 12 (or --start S --end E --every 0.5),
  then Read the PNG. Drill-down at a decision point: python ${vu}/timeline_view.py <video> <start> <end> -o ${dir}/edit/verify/<name>.png
- Loudness of a file/section: ffmpeg -hide_banner -ss S -t D -i <file> -af ebur128 -f null -   (read the Summary)
- Beats/drops: read ${dir}/edit/music.json (precomputed; beat times, drop candidates, beat period).
- Enhance (per source): write ${dir}/edit/enhance/spec.json ({"clips": [{"id": <asset id>, "type": "video", "path": <file>, "in": S, "len": S, "placedWidth": 1080, "name": "..."}]})
  then python ${s}/tools/enhance.py analyze --spec ${dir}/edit/enhance/spec.json --out ${dir}/edit/enhance/analysis.json and copy
  each clip's "settings" into plan.json "enhance": {"<asset id>": settings}. Look at the sheet_<id>.jpg files first.`;
}

const PLAN_RULES = `## plan.json rules
- Write ONLY plan.json in the project folder (shape below). ReelSmith validates it, shows it to the user as a table to approve
  or change, and builds the timeline from it. Times are SOURCE seconds of the input they refer to (sourceId = asset id).
- Cut points on word boundaries, padded 30-200 ms (speech_cuts.py does this for you). Never cut mid-word.
- Captions "y" is the caption centre as a fraction of the frame height. It must sit inside the safe zone (0.14-0.79:
  top 250 px and bottom 400 px of 1080x1920 are Instagram UI) and never over the face: pick it from the contact sheet.
- faceX/faceY: centre of the face as a fraction of the source frame (from a contact sheet), used to keep the face in frame
  for vertical crops and punch-ins.
- Nobody can answer questions during this run. Decide, and put assumptions and anything the user should check in "summary".
- Apply every active rule of the taste checklist and avoid the known gotchas (both are in your instructions).`;

function modePrompt(mode: PlanMode, p: Project, inputs: ModeInputs, assets: MediaAsset[], dir: string) {
  const roleOf = new Map<string, string>();
  for (const [role, ids] of Object.entries(inputs.assets)) for (const id of ids) roleOf.set(id, role);
  const head = `${MODES[mode].label} edit for ReelSmith project "${p.title}" (${p.aspect}). Project folder: ${dir}

## Inputs (asset id | role | type | file | duration | size | name)
${inputsTable(assets, roleOf)}
${inputs.notes ? `\n## Brief from the user\n${inputs.notes}\n` : ""}${
    inputs.creator
      ? `\n## Creator style: @${inputs.creator}\nRead ${fwd(creatorDir())}/${inputs.creator}/style.json (and teardown.md). Follow its pacing, hook and structure in this plan where\nthey don't conflict with the taste checklist (taste rules always win). Captions, zooms and overlays come in the stage-2 style pass.\n`
      : ""
  }${
    (inputs.assets.background ?? []).length
      ? `\n## Background image\nThe "background" input replaces the background behind the speaker: ReelSmith cuts the person out after approval and\nputs the image behind them. Don't analyse or use it. Prefer shots where the speaker is clearly separated from the background.\n`
      : ""
  }
${toolsBlock(dir)}

${PLAN_RULES}
`;
  switch (mode) {
    case "talking_head":
      return `${head}
## Task: tight talking-head edit
1. Read the transcripts (edit/transcript.json, precomputed). Clips with speech:false have no words to use.
2. For each clip run speech_cuts.py with --phrases. Read the word table: retakes (the same line said again) keep the LAST
   take, false starts go too -> re-run with --drop for the earlier attempts. Keep the speaker's words otherwise.
3. Contact sheet per clip -> faceX/faceY, and a caption y that is in the safe zone and not over the face (usually below the chin).
4. Enhance the clips (enhance.py analyze over the kept windows) -> plan.enhance.
5. Optional hook: a 2-6 word text for the first 2-3 s if the opening line needs one (sassy/motivational, taste checklist R20).
6. Write plan.json:
{"summary": str, "script": "the cleaned script", "sources": [{"id", "faceX", "faceY"}],
 "segments": [{"sourceId", "in", "out", "text": "words in this segment", "include": true}],   // in play order
 "removed": [{"sourceId", "start", "end", "text", "reason": "filler|stutter|retake|false start|pause"}],
 "captions": {"y", "style": "bold|karaoke|minimal|boxed", "why"}, "hook": {"text", "duration"} | null, "enhance": {...}}
ReelSmith alternates 100%/110% punch-ins on jump cuts and adds word-timed captions with the active word highlighted.`;
    case "best_take":
      return `${head}
## Task: best take of every line
${inputs.script ? `Script (align the takes to it line by line):\n"""\n${inputs.script}\n"""` : "No script: align the takes to each other (the line structure the takes share)."}
1. Read the transcripts (edit/transcript.json, precomputed). Split the script into lines (sentences or short beats).
2. For every line find it in every take (word boundaries; run speech_cuts.py per take for clean edges if needed) and
   score each candidate 0-10 on: delivery (no stumbles, clear words, energy, pace), audio quality (noise, level, clipping:
   use ebur128 on the span), framing, focus and lighting (contact sheet / timeline_view of the span). "score" = overall.
3. Pick the best per line; keep up to 3 alternatives with their scores so the user can swap.
4. Per take: loudness -> "gainDb" that brings each take to the same integrated loudness (target the median take, max ±12).
   Enhance all takes (one analyze over one representative window each): the match fix makes the cuts invisible -> plan.enhance.
5. Write plan.json:
{"summary", "script", "sources": [{"id", "faceX", "faceY", "gainDb", "notes"}],
 "lines": [{"text", "chosen": {"sourceId", "in", "out", "score", "scores": {"delivery","audio","framing","focus","lighting"}, "note"},
            "alternatives": [same shape], "why": "why the chosen take wins"}],
 "captions": {"y", "style", "why"}, "enhance": {...}}`;
    case "voiceover_broll":
      return `${head}
## Task: voiceover with matched b-roll
1. Read the voice transcript (edit/transcript.json, precomputed). If the voice input is a video, note where the face is (faceX/faceY).
2. Analyse every b-roll clip: contact sheet, what it shows (exercise, place, objects, action), its best moments (in/out)
   and quality (shake, focus, light).
3. Split the voice into segments on word or phrase boundaries and match each to the b-roll that shows what is being said at that
   moment (e.g. "squats" -> the squat clip, at its best moment). Use each clip's best moments; avoid repeating a shot back to back;
   2-5 s per segment. ${inputs.faceCutbacks ? "Cut back to the face (sourceId = the voice id, in = segment start) for the key lines: the hook, the main claim, the call to action." : "Do not cut back to the face."}
   Segments are contiguous and cover the whole voice from 0 to its end.
4. Enhance the b-roll used (and the face video) -> plan.enhance. Pick a caption y in the safe zone.
5. Write plan.json:
{"summary", "voiceId", "script", "broll": [{"id", "shows", "quality", "best": [{"in", "out", "why"}]}],
 "segments": [{"start", "end", "text", "sourceId", "in", "why"}],   // start/end = voice seconds, in = source second of the b-roll
 "face": {"faceX", "faceY"} | null, "captions": {"y", "style", "why"},
 "music": ${(inputs.assets.music ?? []).length ? `{"sourceId": "${inputs.assets.music[0]}", "volume": 0.5}` : "null"}, "enhance": {...}}
Music (if any) is ducked under the voice automatically.`;
    case "music":
      return `${head}
## Task: music edit (the edit-reel workflow, planned instead of rendered)
Read ${fwd(studioDir())}/.claude/skills/edit-reel/SKILL.md and follow steps 1-4 and the rules at its end (style, sort the clips,
plan the cut, music & beat sync). Differences in this headless run: do not ask, pick the recommended defaults (crop
horizontals, grey grind -> colour reveal), do not build or render.
${(inputs.assets.music ?? []).length ? "The track is the music input." : inputs.musicUrl ? `Fetch the sound: python -m yt_dlp -x --audio-format mp3 -o ${dir}/edit/music.%(ext)s "${inputs.musicUrl}" (Instagram /reels/audio/ links don't work; say so in summary if it fails).` : "No track: cut to the footage's own rhythm; musicId and musicFile are null."}
Use the beats in ${dir}/edit/music.json (precomputed); every cut on a beat or strong onset, the reveal on the drop. Enhance the shots' windows -> plan.enhance.
## Pacing (taste checklist R16, your feedback 2026-10-02: the old ~3 s shots and 8 s holds felt monotonous and lose watch time)
- Hook: 2-3 cuts in the first 2 s; the first frame already moving.
- Grind/build: 1-2 beats per shot (at 100-130 BPM about 0.5-1.2 s); never more than 4 beats on one shot.
- Reveal: cut ON the drop, then keep changing every 2-4 beats (other angles, other moments of the payoff clip, a 0.6-0.8x slow-mo
  moment, back to 1x) instead of one long hold; no single shot over ~3 s. Re-use the strongest clips: different moments of
  the same clip are fine, the same moment twice is not.
- Aim for 12-25 shots in a 15-20 s reel. Every shot still starts and ends on a movement boundary (never mid-rep).
- ReelSmith adds the beat effects on approve (zoom punches on beats, shake + flash on the drop, beat cuts where the source
  resolution allows a punch-in). Pick "energy": "subtle" | "punchy" (default) | "hype" from the track and the brief.
  Per shot you may set "transition": "flash" (the drop), "zoom" (a section change), "slide", "crossfade" (rare), "cut",
  or null to let ReelSmith decide.
Write plan.json:
{"summary": "... and which second of the song the edit starts from", "musicId": asset id | null, "musicFile": "edit/music.mp3" | null,
 "musicStart": S, "energy": "punchy",
 "shots": [{"sourceId", "in", "out", "start", "end", "zoom", "cx", "cy", "grade": "grey"|"bw"|"warm"|null, "transition": null, "why"}],
 "texts": [{"text", "start", "end", "y", "accent"}], "enhance": {...}}
shots: start/end = reel seconds (contiguous from 0), in/out = source seconds (speed = (out-in)/(end-start), keep 0.5-2).
cx/cy = crop/zoom anchor (fraction of the source frame). texts: the house style's lowercase phrases, y inside the safe zone,
on screen at least 1.2 s each (they don't need to change with every cut).`;
    case "auto_clip":
      return `${head}
## Task: cut ${inputs.count ?? 3} shorts from one long video
1. Read the source's transcript (edit/transcript.json, precomputed).
2. Find the ${inputs.count ?? 3} strongest self-contained moments, ${inputs.minSec ?? 15}-${inputs.maxSec ?? 60} s each: a clear hook in the first
   2 s, one idea, a satisfying end (no trailing half sentence). Start and end on sentence boundaries.
3. Score each 0-10 (hook strength, payoff, clarity, energy), write a short title and a 2-6 word on-screen hook.
4. Contact sheet -> faceX/faceY (for the vertical crop) and a caption y in the safe zone, off the face.
5. Write plan.json:
{"summary", "sourceId", "faceX", "faceY", "clips": [{"title", "start", "end", "hook", "why", "score", "include": true}],
 "captions": {"y", "style", "why"}}
Order clips by score, best first. Up to ${(inputs.count ?? 3) + 2} candidates; mark the best ${inputs.count ?? 3} include: true.`;
  }
}

// ---------------------------------------------------------------- jobs

async function modeAssets(userId: string, inputs: ModeInputs) {
  const ids = [...new Set(Object.values(inputs.assets).flat())];
  const assets = await prisma.mediaAsset.findMany({ where: { userId, id: { in: ids } } });
  if (assets.length !== ids.length) throw new HttpError(400, "Some inputs are missing from your library");
  return assets;
}

export function validateInputs(mode: PlanMode, inputs: ModeInputs) {
  for (const [role, r] of Object.entries(MODES[mode].roles)) {
    const ids = inputs.assets[role] ?? [];
    if (r.required && !ids.length) throw new HttpError(400, `${MODES[mode].label}: add ${r.label.toLowerCase()}`);
    if (!r.many && ids.length > 1) throw new HttpError(400, `${MODES[mode].label}: only one ${r.label.toLowerCase()}`);
  }
}

export async function startPlan(project: Project) {
  const mode = project.mode as PlanMode;
  const inputs = project.inputs as unknown as ModeInputs;
  const assets = await modeAssets(project.userId, inputs);
  const dir = fwd(ensureProjectDir(project.id));
  // The fixed steps (probe, transcripts, beats) run first as one command, so the plan job only reads their output.
  const musicIds = new Set(inputs.assets.music ?? []);
  const filesOf = (track: boolean) =>
    assets.filter((a) => musicIds.has(a.id) === track).map((a) => localMediaPath(a.url)).filter((p): p is string => Boolean(p));
  const prep = await createJob({
    userId: project.userId,
    projectId: project.id,
    kind: "prep",
    title: `${MODES[mode].label}: prep`,
    prompt: "",
    exec: [
      workerPython(), path.join(appDir(), "worker", "prepare.py"), "--dir", dir,
      ...filesOf(false).flatMap((p) => ["--clip", p]),
      ...filesOf(true).flatMap((p) => ["--audio", p]),
    ],
    timeoutSec: 20 * 60,
  });
  const job = await createJob({
    userId: project.userId,
    projectId: project.id,
    kind: "plan",
    title: `${MODES[mode].label}: plan`,
    prompt: modePrompt(mode, project, inputs, assets, dir),
    resumeSessionId: await projectSession(project.id), // continue the project's chat, if it started there
    outputFile: "plan.json",
    schema: `plan-${mode}` as SchemaName,
    freshOutput: true,
    afterJobId: prep.id,
    timeoutSec: mode === "auto_clip" ? 3 * 3600 : 90 * 60,
  });
  await prisma.project.update({ where: { id: project.id }, data: { status: "planning", statusMessage: null, planJobId: job.id } });
  return job;
}

/**
 * The user's edits are written back to plan.json, then the same Claude session revises it. notes = the feedback is the user's own
 * (not already filed by a chat turn): the job turns it into rules first (taste checklist R2).
 */
export async function revisePlan(project: Project, feedback: string, plan: unknown, o: { notes?: boolean; title?: string } = {}) {
  const mode = project.mode as PlanMode;
  const parsed = PLAN_SCHEMAS[mode].safeParse(plan);
  if (!parsed.success) throw new HttpError(400, "The plan is invalid");
  const dir = ensureProjectDir(project.id);
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify(parsed.data, null, 1));
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const job = await createJob({
    id,
    userId: project.userId,
    projectId: project.id,
    kind: "plan",
    title: o.title ?? `${MODES[mode].label}: revise`,
    prompt: `The user reviewed plan.json (their table edits are already saved in it) and asks:\n"""\n${feedback}\n"""\n${o.notes ? notesBlock(dir, id, "cut") : ""}\nRevise plan.json accordingly (same shape, same rules). Keep everything they didn't ask to change. Fix the cause, not just the moment they named, and check the whole cut for the same problem (R4). Say what you changed at the start of "summary".`,
    resumeSessionId: await projectSession(project.id),
    outputFile: "plan.json",
    schema: `plan-${mode}` as SchemaName,
    timeoutSec: 60 * 60,
  });
  await prisma.project.update({ where: { id: project.id }, data: { status: "planning", plan: parsed.data as Prisma.InputJsonValue, planJobId: job.id } });
  return job;
}

/**
 * Poll-time transition: planning -> review (plan.json valid) or plan_failed. Before the cut is shown, a fresh checker checks
 * it against the taste checklist (R5) and the project's session fixes what failed: plan job -> check -> fix job -> review.
 */
export async function syncPlanStatus(project: Project) {
  if (project.status !== "planning" || !project.planJobId) return project;
  const job = await prisma.agentJob.findUnique({ where: { id: project.planJobId } });
  if (!job || job.status === "queued" || job.status === "running") return project;
  await absorbNotes(project, job.id, "cut"); // notes on the cut become rules even when the revision failed
  const dir = ensureProjectDir(project.id);
  const readPlan = () => {
    const file = path.join(dir, "plan.json");
    let raw: unknown = null;
    try {
      raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) : null;
    } catch {
      raw = null;
    }
    return PLAN_SCHEMAS[project.mode as PlanMode].safeParse(raw);
  };
  const review = (plan: unknown, statusMessage: string | null = null) =>
    prisma.project.update({ where: { id: project.id }, data: { status: "review", statusMessage, plan: plan as Prisma.InputJsonValue } });

  const fixOf = await prisma.ruleCheck.findFirst({ where: { fixJobId: job.id } });
  if (fixOf) {
    // the fix turn of a rule check finished: show the fixed cut (or the checked one, if the fix broke)
    const parsed = job.status === "done" ? readPlan() : null;
    if (parsed?.success) {
      await finishCheck(project, fixOf.id);
      return review(parsed.data);
    }
    writeFileSync(path.join(dir, "plan.json"), JSON.stringify(project.plan, null, 1));
    await finishCheck(project, fixOf.id, { fixFailed: `the fix turn ${job.status === "done" ? "wrote an invalid plan" : job.status}; showing the cut as it was checked` });
    return review(project.plan);
  }
  if (job.status !== "done") {
    return prisma.project.update({ where: { id: project.id }, data: { status: "plan_failed", statusMessage: job.error ?? `Planning ${job.status}` } });
  }
  const parsed = readPlan();
  if (!parsed.success) return prisma.project.update({ where: { id: project.id }, data: { status: "plan_failed", statusMessage: "plan.json is invalid" } });

  // R5: a fresh check of this cut before it is shown
  let rc = await prisma.ruleCheck.findFirst({ where: { subjectJobId: job.id } });
  if (!rc) {
    try {
      await startCheck(project, "cut", job.id);
    } catch (err) {
      return review(parsed.data, `Rule check skipped: ${(err as Error).message}`);
    }
    return prisma.project.update({
      where: { id: project.id },
      data: { plan: parsed.data as Prisma.InputJsonValue, statusMessage: "A fresh checker is checking the cut against your taste checklist" },
    });
  }
  if (rc.status === "checking") {
    const r = await takeReport(project, rc);
    if (r.state === "running") return project;
    if (r.state === "failed") {
      await failCheck(project, rc.id, r.note);
      return review(parsed.data);
    }
    if (!r.toFix.length) {
      await finishCheck(project, rc.id);
      return review(parsed.data);
    }
    rc = (await prisma.ruleCheck.findUnique({ where: { id: rc.id } }))!;
    const fix = await revisePlan({ ...project, plan: parsed.data as Prisma.JsonValue }, fixBrief(rc.id, r.report, dir), parsed.data, {
      title: `${MODES[project.mode as PlanMode].label}: fix what the rule check found`,
    });
    await prisma.ruleCheck.update({ where: { id: rc.id }, data: { status: "fixing", fixJobId: fix.id } });
    return prisma.project.update({
      where: { id: project.id },
      data: { statusMessage: `Fixing ${r.toFix.length} thing${r.toFix.length > 1 ? "s" : ""} the rule check found` },
    });
  }
  // the check of this plan is already closed: show it
  return review(parsed.data);
}

// ---------------------------------------------------------------- building

export type Ctx = { aspect: Aspect; W: number; H: number; assets: Map<string, MediaAsset>; words: Map<string, Word[]>; grade: Grade | null };

/** edit/transcript.json (edit-reel transcribe.py) -> timeline words per asset id (source seconds). */
function loadTranscripts(projectId: string, assets: MediaAsset[]) {
  const file = path.join(ensureProjectDir(projectId), "edit", "transcript.json");
  const out = new Map<string, Word[]>();
  if (!existsSync(file)) return out;
  const data = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as { clip: string; words: { word: string; start: number; end: number }[] }[];
  const byFile = new Map(data.map((c) => [c.clip, c.words]));
  for (const a of assets) {
    const p = localMediaPath(a.url);
    const ws = p ? byFile.get(path.basename(p)) : undefined;
    if (!ws) continue;
    const prefix = a.id.slice(-6);
    out.set(
      a.id,
      ws.filter((w) => w.word.trim()).map((w, i) => ({ id: `${prefix}_${i}`, text: w.word.trim(), start: w.start, end: w.end })),
    );
  }
  return out;
}

/** Largest zoom that doesn't scale the source past its own resolution (taste checklist R13: no upscaling past the source). */
export function maxZoom(ctx: Ctx, a: MediaAsset) {
  const base = Math.max(ctx.W / (a.width ?? ctx.W), ctx.H / (a.height ?? ctx.H));
  return Math.max(1, 1 / base);
}

/** Transform that keeps the face in frame: centred horizontally (if the crop allows), and at the same screen
 * position for a punch-in as without it, so a 110% punch-in zooms toward the face. */
function faceTransform(ctx: Ctx, a: MediaAsset, fx: number, fy: number, zoomWanted = 1): Transform {
  const sw = a.width ?? ctx.W;
  const sh = a.height ?? ctx.H;
  const zoom = Math.min(zoomWanted, maxZoom(ctx, a));
  const at = (scale: number, x: number, y: number) => {
    const p = placement(sw, sh, ctx.W, ctx.H, { fit: "cover", scale, x, y });
    return { p, fxPx: p.x + fx * p.w, fyPx: p.y + fy * p.h };
  };
  const clamp = (v: number, room: number) => Math.max(-room, Math.min(room, v));
  // zoom 1: face horizontally centred within the available crop
  const p1 = at(1, 0, 0);
  const x1 = clamp((ctx.W / 2 - p1.fxPx) / ctx.W, (p1.p.w - ctx.W) / 2 / ctx.W);
  if (zoom <= 1.001) return { fit: "cover", scale: 1, x: round(x1), y: 0 };
  const target = at(1, x1, 0);
  const pz = at(zoom, 0, 0);
  const x = clamp((target.fxPx - pz.fxPx) / ctx.W, (pz.p.w - ctx.W) / 2 / ctx.W);
  const y = clamp((target.fyPx - pz.fyPx) / ctx.H, (pz.p.h - ctx.H) / 2 / ctx.H);
  return { fit: "cover", scale: zoom, x: round(x), y: round(y) };
}
const round = (v: number) => Math.round(v * 10000) / 10000;

function videoClip(ctx: Ctx, a: MediaAsset, start: number, srcIn: number, srcOut: number, extra: Partial<VisualClip> = {}): VisualClip {
  const speed = extra.speed ?? 1;
  return newVisualClip({
    type: a.type === "image" ? "image" : "video",
    start,
    duration: a.type === "image" ? Math.max(0.2, srcOut - srcIn) : Math.max(0.1, (srcOut - srcIn) / speed),
    in: a.type === "image" ? 0 : srcIn,
    src: a.url,
    assetId: a.id,
    thumb: a.thumbUrl,
    name: a.name,
    srcDuration: a.duration,
    srcWidth: a.width,
    srcHeight: a.height,
    hasAudio: ((a.meta ?? {}) as { hasAudio?: boolean }).hasAudio ?? a.type === "video",
    muted: true, // speech comes from the voice track (same file), so captions and ripple edits work
    kenBurns: null,
    ...extra,
  });
}

function voiceClip(a: MediaAsset, start: number, srcIn: number, srcOut: number, volume = 1): AudioClip {
  const d = srcOut - srcIn;
  return newAudioClip({
    src: a.url,
    assetId: a.id,
    name: a.name,
    start,
    duration: d,
    in: srcIn,
    srcDuration: a.duration,
    volume: Math.min(2, Math.max(0, volume)),
    fadeIn: Math.min(0.03, d / 4), // 30 ms fades: no pops at cuts
    fadeOut: Math.min(0.03, d / 4),
  });
}

function setCaptions(tl: Timeline, c: { y: number; style: Timeline["captions"]["style"] }) {
  tl.captions = { ...tl.captions, enabled: true, style: c.style, y: Math.min(SAFE_BOTTOM - 0.03, Math.max(SAFE_TOP + 0.03, c.y)) };
}

function withEnhance(clip: VisualClip, enh: Record<string, Enhance> | undefined) {
  const e = enh?.[clip.assetId ?? ""];
  if (e) clip.enhance = { ...e };
  return clip;
}

/** The look picked on the new-edit page (talking head / best take), on every clip. */
function withGrade(clip: VisualClip, ctx: Ctx) {
  if (ctx.grade) clip.grade = { ...ctx.grade };
  return clip;
}

const track = <K extends Timeline["tracks"][number]["kind"]>(tl: Timeline, kind: K) =>
  tl.tracks.find((t) => t.kind === kind) as Extract<Timeline["tracks"][number], { kind: K }>;

function hookText(ctx: Ctx, text: string, duration: number): TextClip {
  const t = newTextClip("title", 0, ctx.aspect, text);
  t.duration = duration;
  t.style = { ...t.style, y: Math.max(SAFE_TOP + 0.06, Math.min(0.3, t.style.y)) };
  return t;
}

function addTranscripts(tl: Timeline, ctx: Ctx, ids: Iterable<string>) {
  for (const id of ids) {
    const w = ctx.words.get(id);
    if (w?.length) tl.transcripts[id] = { words: w };
  }
}

export function buildTalkingHead(plan: TalkingHeadPlan, ctx: Ctx) {
  const tl = emptyTimeline(ctx.aspect);
  const faces = new Map(plan.sources.map((s) => [s.id, s]));
  let t = 0;
  let prev: { sourceId: string; out: number } | null = null;
  let zoomed = false;
  for (const s of plan.segments.filter((x) => x.include !== false)) {
    const a = ctx.assets.get(s.sourceId);
    if (!a) continue;
    const jump = prev && prev.sourceId === s.sourceId && Math.abs(s.in - prev.out) > 0.05;
    zoomed = jump ? !zoomed : false; // alternate 100% / 110% on jump cuts
    const f = faces.get(s.sourceId) ?? { faceX: 0.5, faceY: 0.4 };
    track(tl, "video").clips.push(withGrade(withEnhance(videoClip(ctx, a, t, s.in, s.out, { transform: faceTransform(ctx, a, f.faceX, f.faceY, zoomed ? 1.1 : 1) }), plan.enhance), ctx));
    track(tl, "voice").clips.push(voiceClip(a, t, s.in, s.out));
    t += s.out - s.in;
    prev = { sourceId: s.sourceId, out: s.out };
  }
  setCaptions(tl, plan.captions);
  addTranscripts(tl, ctx, plan.sources.map((s) => s.id));
  if (plan.hook) track(tl, "text").clips.push(hookText(ctx, plan.hook.text, Math.min(plan.hook.duration, t)));
  return { tl, duration: t };
}

export function buildBestTake(plan: BestTakePlan, ctx: Ctx) {
  const tl = emptyTimeline(ctx.aspect);
  const src = new Map(plan.sources.map((s) => [s.id, s]));
  let t = 0;
  for (const line of plan.lines) {
    const c = line.chosen;
    const a = ctx.assets.get(c.sourceId);
    if (!a) continue;
    const s = src.get(c.sourceId);
    track(tl, "video").clips.push(withGrade(withEnhance(videoClip(ctx, a, t, c.in, c.out, { transform: faceTransform(ctx, a, s?.faceX ?? 0.5, s?.faceY ?? 0.4) }), plan.enhance), ctx));
    track(tl, "voice").clips.push(voiceClip(a, t, c.in, c.out, Math.pow(10, (s?.gainDb ?? 0) / 20)));
    t += c.out - c.in;
  }
  setCaptions(tl, plan.captions);
  addTranscripts(tl, ctx, plan.sources.map((s) => s.id));
  return { tl, duration: t };
}

export function buildVoiceover(plan: VoiceoverPlan, ctx: Ctx) {
  const tl = emptyTimeline(ctx.aspect);
  const voice = ctx.assets.get(plan.voiceId);
  if (!voice) throw new HttpError(400, "The voice input is missing");
  const end = Math.max(...plan.segments.map((s) => s.end));
  const duration = Math.min(voice.duration ?? end, end);
  track(tl, "voice").clips.push(voiceClip(voice, 0, 0, duration));
  for (const s of [...plan.segments].sort((x, y) => x.start - y.start)) {
    const a = ctx.assets.get(s.sourceId);
    if (!a || s.end <= s.start) continue;
    const face = s.sourceId === plan.voiceId;
    const len = s.end - s.start;
    const srcIn = face ? s.start : Math.max(0, Math.min(s.in, Math.max(0, (a.duration ?? s.in + len) - len)));
    const transform = face && plan.face ? faceTransform(ctx, a, plan.face.faceX, plan.face.faceY) : undefined;
    const clip = videoClip(ctx, a, s.start, srcIn, srcIn + len, transform ? { transform } : {});
    if (a.type === "image") clip.kenBurns = { direction: "in", amount: 0.1 };
    track(tl, "video").clips.push(withEnhance(clip, plan.enhance));
  }
  if (plan.music) {
    const m = ctx.assets.get(plan.music.sourceId);
    if (m) {
      const len = Math.min(duration, m.duration ?? duration);
      track(tl, "music").clips.push(newAudioClip({ src: m.url, assetId: m.id, name: m.name, start: 0, duration: len, srcDuration: m.duration, volume: plan.music.volume, duck: true, fadeOut: 1.5, link: musicLink(m, 0, len) }));
    }
  }
  setCaptions(tl, plan.captions);
  addTranscripts(tl, ctx, [plan.voiceId]);
  return { tl, duration };
}

const GRADE: Record<string, Partial<Filters>> = {
  grey: { saturation: 0.12, contrast: 1.06, brightness: 0.99 },
  bw: { saturation: 0, contrast: 1.12, preset: "bw" },
  warm: { preset: "warm", saturation: 0.9, brightness: 0.97 },
};

/** A link-sourced track's origin, so the clip shows which part of the sound to pick in Instagram. */
function musicLink(a: MediaAsset, start: number, len: number): AudioClip["link"] {
  const l = ((a.meta ?? {}) as { link?: { url: string; kind: "instagram" | "youtube" | "direct" } }).link;
  return l ? { url: l.url, kind: l.kind, start: Math.round(start * 1000) / 1000, end: Math.round((start + len) * 1000) / 1000 } : null;
}

/** The track's beat grid: the asset's stored analysis, else the plan run's edit/music.json (beats.py, source seconds). */
function musicBeats(projectId: string, music: MediaAsset): TrackBeats | null {
  const an = ((music.meta ?? {}) as { analysis?: TrackBeats }).analysis;
  if (an?.beats?.length) return an;
  const file = path.join(ensureProjectDir(projectId), "edit", "music.json");
  if (!existsSync(file)) return null;
  try {
    const j = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as { beats?: number[]; drop_candidates?: { t: number; score: number }[]; beat_period?: number };
    return j.beats?.length ? { beats: j.beats, drops: [...(j.drop_candidates ?? [])].sort((a, b) => b.score - a.score), beatPeriod: j.beat_period ?? null } : null;
  } catch {
    return null;
  }
}

export function buildMusic(plan: MusicPlan, ctx: Ctx, music: MediaAsset | null, beats: TrackBeats | null = null) {
  const tl = emptyTimeline(ctx.aspect);
  let end = 0;
  for (const s of [...plan.shots].sort((x, y) => x.start - y.start)) {
    const a = ctx.assets.get(s.sourceId);
    if (!a || s.end <= s.start) continue;
    const speed = Math.min(2, Math.max(0.5, (s.out - s.in) / (s.end - s.start)));
    const clip = videoClip(ctx, a, s.start, s.in, s.in + (s.end - s.start) * speed, {
      speed,
      transform: faceTransform(ctx, a, s.cx, s.cy, s.zoom),
    });
    clip.duration = s.end - s.start;
    if (s.grade) clip.filters = { ...clip.filters, ...GRADE[s.grade] };
    if (s.transition && s.transition !== "cut") clip.transition = { type: s.transition, duration: s.transition === "crossfade" ? 0.4 : s.transition === "flash" ? 0.3 : 0.2 };
    track(tl, "video").clips.push(withEnhance(clip, plan.enhance));
    end = Math.max(end, s.end);
  }
  for (const x of plan.texts) {
    const t = newTextClip("headline", x.start, ctx.aspect, x.text.toLowerCase());
    t.duration = Math.max(0.5, x.end - x.start);
    t.style = { ...t.style, font: "playfair", uppercase: false, y: Math.min(SAFE_BOTTOM - 0.05, Math.max(SAFE_TOP + 0.05, x.y)), color: x.accent ? "#FFD60A" : "#FFFFFF", outline: 5, outlineColor: "#111111" };
    track(tl, "text").clips.push(t);
  }
  if (music) {
    const len = Math.min(end, (music.duration ?? plan.musicStart + end) - plan.musicStart);
    track(tl, "music").clips.push(newAudioClip({ src: music.url, assetId: music.id, name: music.name, start: 0, in: plan.musicStart, duration: len, srcDuration: music.duration, volume: 1, fadeOut: 0.4, link: musicLink(music, plan.musicStart, len) }));
  }
  tl.captions.enabled = false; // music edits carry their own text
  if (music && beats) {
    const tb = timelineBeats(tl, { [music.id]: beats });
    if (tb.beats.length) return { tl: energize(tl, tb, plan.energy ?? "punchy").timeline, duration: end };
  }
  return { tl, duration: end };
}

export function buildShort(plan: AutoClipPlan, ctx: Ctx, c: AutoClipPlan["clips"][number]) {
  const a = ctx.assets.get(plan.sourceId)!;
  const tl = emptyTimeline(ctx.aspect);
  const d = c.end - c.start;
  track(tl, "video").clips.push(videoClip(ctx, a, 0, c.start, c.end, { transform: faceTransform(ctx, a, plan.faceX, plan.faceY) }));
  track(tl, "voice").clips.push(voiceClip(a, 0, c.start, c.end));
  if (c.hook) track(tl, "text").clips.push(hookText(ctx, c.hook, Math.min(2.5, d)));
  setCaptions(tl, plan.captions);
  addTranscripts(tl, ctx, [plan.sourceId]);
  return { tl, duration: d };
}

/** A file Claude downloaded into the project folder (e.g. the music) -> a library asset. */
function importProjectFile(userId: string, projectId: string, rel: string) {
  const dir = ensureProjectDir(projectId);
  const src = path.resolve(dir, rel);
  if (!src.startsWith(dir + path.sep) || !existsSync(src)) return null;
  const key = `u/${userId}/music/${crypto.randomBytes(6).toString("hex")}-${path.basename(src).replace(/[^\w.-]/g, "_")}`;
  const dst = localPath(key);
  mkdirSync(path.dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return { key, url: publicUrl(key), size: statSync(dst).size, name: path.basename(src) };
}

async function saveTimeline(projectId: string, tl: Timeline, duration: number, label: string, thumb: string | null) {
  tl.fps = await sourceFps(tl);
  const owner = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } });
  if (owner) await withClientLook(owner.userId, tl); // the client's default look (brand kit); the editor builds it
  const json = tl as unknown as Prisma.InputJsonValue;
  await prisma.$transaction([
    prisma.timeline.upsert({ where: { projectId }, create: { projectId, json }, update: { json, revision: { increment: 1 } } }),
    prisma.timelineVersion.create({ data: { projectId, name: label, kind: "first-cut", json } }),
    prisma.project.update({ where: { id: projectId }, data: { status: "ready", statusMessage: null, duration, thumbnailUrl: thumb } }),
  ]);
}

/** Approve the (user-edited) plan: build the timeline(s). Auto-clip creates one new project per chosen short. */
export async function approvePlan(project: Project, plan: unknown) {
  const mode = project.mode as PlanMode;
  const parsed = PLAN_SCHEMAS[mode].safeParse(plan);
  if (!parsed.success) throw new HttpError(400, `The plan is invalid: ${parsed.error.issues[0]?.message ?? ""}`);
  const inputs = project.inputs as unknown as ModeInputs;
  const assets = await modeAssets(project.userId, inputs);
  const size = DESIGN_SIZE[project.aspect as Aspect];
  const ctx: Ctx = {
    aspect: project.aspect as Aspect,
    W: size.width,
    H: size.height,
    assets: new Map(assets.map((a) => [a.id, a])),
    words: loadTranscripts(project.id, assets),
    grade: (mode === "talking_head" || mode === "best_take") && inputs.grade?.look === "cinematic_warm" ? { look: "cinematic_warm", intensity: Math.min(1, Math.max(0, Number(inputs.grade.intensity) || 0)) } : null,
  };
  const thumbOf = (tl: Timeline) => (track(tl, "video").clips.find((c) => c.thumb)?.thumb ?? null) as string | null;
  await prisma.project.update({ where: { id: project.id }, data: { plan: parsed.data as Prisma.InputJsonValue } });

  if (mode === "auto_clip") {
    const p = parsed.data as AutoClipPlan;
    const chosen = p.clips.filter((c) => c.include !== false);
    if (!chosen.length) throw new HttpError(400, "Pick at least one short");
    const children: string[] = [];
    for (const c of chosen) {
      const { tl, duration } = buildShort(p, ctx, c);
      const child = await prisma.project.create({
        data: { userId: project.userId, title: c.title.slice(0, 80), aspect: project.aspect, mode: "talking_head", parentId: project.id, status: "draft" },
      });
      await saveTimeline(child.id, tl, duration, "Auto-clip", thumbOf(tl));
      children.push(child.id);
    }
    // the source project keeps the whole video, captioned, as an editable timeline
    const a = ctx.assets.get(p.sourceId)!;
    const full = buildShort(p, ctx, { title: project.title, start: 0, end: a.duration ?? 0, hook: "", why: "", score: 0, include: true });
    await saveTimeline(project.id, full.tl, full.duration, "Source", thumbOf(full.tl));
    return { children };
  }

  let built: { tl: Timeline; duration: number };
  if (mode === "talking_head") built = buildTalkingHead(parsed.data as TalkingHeadPlan, ctx);
  else if (mode === "best_take") built = buildBestTake(parsed.data as BestTakePlan, ctx);
  else if (mode === "voiceover_broll") built = buildVoiceover(parsed.data as VoiceoverPlan, ctx);
  else {
    const p = parsed.data as MusicPlan;
    let music = p.musicId ? (ctx.assets.get(p.musicId) ?? null) : null;
    if (!music && p.musicFile) {
      const f = importProjectFile(project.userId, project.id, p.musicFile);
      if (f) {
        music = await prisma.mediaAsset.create({
          data: { userId: project.userId, type: "music", source: "download", key: f.key, url: f.url, name: f.name, tags: ["music"] },
        });
      }
    }
    built = buildMusic(p, ctx, music, music ? musicBeats(project.id, music) : null);
  }
  if (!built.duration) throw new HttpError(400, "Nothing to build: every segment is excluded or its input is missing");
  // background swap: the image on a bottom track, the speaker's clips cut out (matte jobs on the runner; settleMattes
  // switches them on when done). Voiceover: only the face cut-backs, the b-roll stays full frame.
  const bg = ctx.assets.get((inputs.assets.background ?? [])[0] ?? "");
  if (bg && bg.type === "image" && (mode === "talking_head" || mode === "voiceover_broll")) {
    const voiceId = mode === "voiceover_broll" ? (parsed.data as VoiceoverPlan).voiceId : null;
    const people = track(built.tl, "video").clips.filter((c) => c.type === "video" && (!voiceId || c.assetId === voiceId));
    if (people.length) {
      setBackground(built.tl, { url: bg.url, id: bg.id, name: bg.name, thumbUrl: bg.thumbUrl, width: bg.width, height: bg.height });
      await queueMattesFor(project.userId, project.id, people);
    }
  }
  await saveTimeline(project.id, built.tl, built.duration, "Approved plan", thumbOf(built.tl));
  return { children: [] as string[] };
}
