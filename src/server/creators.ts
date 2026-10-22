import "server-only";
// Creator teardown: measure 5 public TikTok / YouTube Shorts videos of one creator, then turn the measurements into
// <creatorDir>/<handle>/teardown.md + style.json that the style pass (src/server/pipeline.ts) applies.
//   job 1 (local command): worker/teardown.py: yt-dlp download, faster-whisper transcripts, ffmpeg scene cuts,
//          zoom / sound-cue analysis, contact sheets -> measurements.json
//   job 2 (Claude, runs after job 1): reads the measurements + sheets, writes style.json (validated) + teardown.md
//   then ReelSmith adds the consistency check across the videos (MISMATCH labels) to both files.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import type { AgentJob } from "@prisma/client";
import { appDir, creatorDir, fwd, workerPython } from "@/agent/config";
import { creatorStyleSchema, type CreatorStyle } from "@/agent/schemas";
import { createJob, jobDTO } from "./agent";
import { prisma } from "./db";
import { HttpError } from "./http";
import { creatorFolder, normHandle, tasteRules } from "./style";
import { resolveStyle } from "@/lib/style/layers";
import { readZip, writeZip } from "@/agent/zip";

export type Platform = "tiktok" | "youtube";
export interface ProfileMeta {
  handle: string;
  platform: Platform;
  urls: string[] | null;
  notes: string;
  userId: string;
  measureJobId: string | null;
  analysisJobId: string | null;
  replacing?: string | null; // video id being replaced
  source?: "links" | "profile" | "import" | "duplicate";
  status: "measuring" | "analysing" | "ready" | "failed";
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

const metaFile = (dir: string) => path.join(dir, "profile.json");
const readJson = <T>(f: string): T | null => {
  try {
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")) as T) : null;
  } catch {
    return null;
  }
};
const writeMeta = (dir: string, m: ProfileMeta) => writeFileSync(metaFile(dir), JSON.stringify({ ...m, updatedAt: new Date().toISOString() }, null, 1));

export function readMeta(handle: string) {
  return readJson<ProfileMeta>(metaFile(creatorFolder(handle)));
}

// ---------------------------------------------------------------- start

export async function startTeardown(o: { userId: string; handle: string; platform?: Platform | null; urls?: string[] | null; notes?: string; projectId?: string | null }) {
  const handle = normHandle(o.handle);
  const urls = (o.urls ?? []).map((u) => u.trim()).filter(Boolean);
  for (const u of urls) {
    if (!/^https:\/\/(www\.|m\.|vm\.|vt\.)?(tiktok\.com|youtube\.com|youtu\.be)\//i.test(u)) throw new HttpError(400, `Only public TikTok or YouTube links: ${u}`);
  }
  if (urls.length && urls.length !== 5) throw new HttpError(400, "Give exactly 5 video links (or none, to take the creator's latest 5)");
  const platform: Platform = o.platform ?? (urls.length && urls.every((u) => /youtu/i.test(u)) ? "youtube" : "tiktok");
  const dir = creatorFolder(handle);
  const prev = readMeta(handle);
  if (prev && (prev.status === "measuring" || prev.status === "analysing")) {
    const busy = await prisma.agentJob.count({ where: { id: { in: [prev.measureJobId, prev.analysisJobId].filter(Boolean) as string[] }, status: { in: ["queued", "running"] } } });
    if (busy) throw new HttpError(409, `A teardown of @${handle} is already running`);
  }
  // a re-run starts clean (downloads, sheets, results)
  for (const sub of ["videos", "transcripts", "sheets", "frames", "jobs"]) rmSync(path.join(dir, sub), { recursive: true, force: true });
  for (const f of ["measurements.json", "style.json", "style.measured.json", "teardown.md", "progress.json"]) rmSync(path.join(dir, f), { force: true });
  mkdirSync(path.join(dir, "jobs"), { recursive: true });

  const measure = await createJob({
    userId: o.userId,
    projectId: o.projectId ?? null,
    kind: "teardown_measure",
    title: `Teardown @${handle}: download + measure`,
    prompt: "(local command)",
    exec: [
      workerPython(),
      path.join(appDir(), "worker", "teardown.py"),
      "--out",
      dir,
      "--handle",
      handle,
      "--platform",
      platform,
      ...(urls.length ? ["--urls", ...urls] : ["--n", "5"]),
    ],
    workDir: dir,
    timeoutSec: 60 * 60,
  });
  const analysis = await createJob({
    userId: o.userId,
    projectId: o.projectId ?? null,
    kind: "teardown",
    title: `Teardown @${handle}: style analysis`,
    prompt: analysisPrompt(handle, platform, dir, o.notes ?? ""),
    outputFile: "style.json",
    schema: "creator-style",
    workDir: dir,
    afterJobId: measure.id,
    timeoutSec: 45 * 60,
  });
  const now = new Date().toISOString();
  writeMeta(dir, {
    handle,
    platform,
    urls: urls.length ? urls : null,
    notes: o.notes ?? "",
    userId: o.userId,
    measureJobId: measure.id,
    analysisJobId: analysis.id,
    status: "measuring",
    error: null,
    replacing: null,
    source: urls.length ? "links" : "profile",
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  });
  return { handle, measure: jobDTO(measure), analysis: jobDTO(analysis) };
}

function analysisPrompt(handle: string, platform: Platform, dirAbs: string, notes: string, replaced?: string) {
  const dir = fwd(dirAbs);
  return `## Creator teardown: @${handle} (${platform})${replaced ? `\nRe-analysis: video ${replaced} was replaced by a new one (see measurements.json). Rewrite style.json and teardown.md for the current set of videos.` : ""}
Profile folder (write only here): ${dir}
- ${dir}/measurements.json: per video: cut times (scene + jump cuts), shot lengths, cuts in the first 3 s, words per minute,
  first spoken word, the hook (words said in the first 3 s), pauses, punch-in cuts (scale across a cut) and smooth zooms,
  audio onsets, the share of cuts that land on a sound cue, a music-bed estimate. "aggregate" has mean/median/cv per metric.
- ${dir}/transcripts/<id>.json: word-level transcripts (faster-whisper, local).
- ${dir}/sheets/<id>_hook.jpg (first 3 s at 4 fps) and <id>_all.jpg (the whole video): contact sheets. Read them: they are images.
- ${dir}/frames/<id>_<hook|captions|zoom|cut|layout|ending>.jpg: single frames per category (360 px wide) for closer looks.
${notes ? `\nNotes from the user: ${notes}\n` : ""}
## Do
1. Read measurements.json and BOTH sheets of every video. Use the measured numbers; don't re-measure them, and never invent one
   that wasn't measured (use null).
2. Per video ("videos"[].observed), from its sheets and transcript. These categories are compared across the videos, so use
   exactly one of the listed values: hookType (question | bold-claim | result-first | pattern-interrupt | story | list-teaser | demo |
   other), captionStyle (bold | karaoke = active word highlighted | minimal | boxed | none), captionPosition, captionCase, zoomStyle
   (punch = scale jumps at cuts, smooth = slow push-ins | mixed | none), layout (talking-head | full-body | broll-heavy | split-screen |
   green-screen | text-on-video | screen-recording | mixed), music (true/false), structureType (list | timeline | story | tutorial |
   day-in-life | transformation | reaction | other). Put the specifics in the free-text hookDetail, layoutDetail and structure.
3. The creator's style across the videos (the majority when they differ; say so in "notes"):
   hooks (pattern + examples = their actual opening lines), pacing (the aggregate MEDIANS), structure (beats, CTA),
   pacing.first2s (cutsFirst2s / wordsFirst2s medians + what the viewer sees), captions (style, position, y = caption centre as a
   fraction of the frame height, case, words per line and on screen, size + sizePx in 1080x1920 pixels, font = the closest of
   inter | montserrat | bebas | playfair | marker, fontFeel, colours as #RRGGBB), zooms (perMinute = punchInsPerMin + smoothZoomsPerMin
   medians, style, typicalScale from punchInCuts), sound (music, sound effects you can infer: e.g. whooshes when cutsOnSoundCue is high;
   sfxPerMin from soundCuesPerMin), visuals (overlays: stickers, arrows, emoji, screenshots, b-roll cutaways, progress bars), layout.
4. Write ${dir}/teardown.md: a readable teardown with sections Hooks, Pacing & cut rhythm, Structure, Captions, Zooms, Sound cues,
   Layout, and "How to apply this style": concrete rules with numbers a style pass can follow (e.g. "punch-in 1.12x every 4-6 s on the
   stressed word", "captions: 2-3 words, uppercase, y 0.62, yellow active word"). Quote the measurements.
   ReelSmith appends the consistency check across the videos (MISMATCH labels) to both files afterwards: don't write one.
5. Write ${dir}/style.json:
{"handle": "${handle}", "platform": "${platform}", "summary": "2-4 sentences",
 "videos": [{"id", "url", "title", "observed": {"hookType", "hookDetail", "captionStyle", "captionPosition", "captionCase", "zoomStyle", "layout", "layoutDetail", "music", "structureType", "structure"}}],
 "hooks": {"pattern", "textOnScreen", "firstWordSec", "examples": [], "notes"},
 "pacing": {"avgShotSec", "medianShotSec", "cutsPerSec", "cutsFirst3s", "wordsPerMin", "pausesRemoved", "first2s": {"cuts", "words", "notes"}, "notes"},
 "structure": {"beats": [], "avgDurationSec", "cta", "notes"},
 "captions": {"present", "style", "position", "y", "case", "wordsPerLine", "wordsOnScreen", "size": "small|medium|large|huge", "sizePx", "font", "fontFeel", "color", "highlight", "notes"},
 "zooms": {"perMinute", "style", "typicalScale", "onEmphasis", "notes"},
 "sound": {"music", "musicLevel", "sfx": [], "sfxPerMin", "cutsOnSoundCue", "notes"},
 "visuals": {"overlays": [], "emojis", "broll", "progressBar", "notes"},
 "layout": {"framing", "faceY", "broll", "textCards", "splitScreen", "notes"}}
captionPosition/position: top | upper-middle | middle | lower-middle | bottom | none.`;
}

// ---------------------------------------------------------------- consistency (MISMATCH labels)

type Measured = { id: string; title?: string | null } & Record<string, unknown>;
const NUMERIC: { key: string; label: string; unit: string; rel: number; abs: number }[] = [
  { key: "durationSec", label: "Length", unit: "s", rel: 0.5, abs: 10 },
  { key: "avgShotSec", label: "Average shot", unit: "s", rel: 0.35, abs: 0.4 },
  { key: "cutsPerSec", label: "Cuts per second", unit: "", rel: 0.4, abs: 0.1 },
  { key: "cutsFirst3s", label: "Cuts in the first 3 s", unit: "", rel: 0, abs: 1.5 },
  { key: "wordsPerMin", label: "Words per minute", unit: "", rel: 0.2, abs: 15 },
  { key: "firstWordSec", label: "First word at", unit: "s", rel: 0, abs: 0.5 },
  { key: "punchInsPerMin", label: "Punch-ins per minute", unit: "", rel: 0.5, abs: 2 },
  { key: "smoothZoomsPerMin", label: "Smooth zooms per minute", unit: "", rel: 0.5, abs: 2 },
  { key: "cutsOnSoundCue", label: "Cuts on a sound cue", unit: "", rel: 0, abs: 0.25 },
];
const CATEGORICAL: { key: keyof CreatorStyle["videos"][number]["observed"]; label: string }[] = [
  { key: "hookType", label: "Hook type" },
  { key: "captionStyle", label: "Caption style" },
  { key: "captionPosition", label: "Caption position" },
  { key: "captionCase", label: "Caption case" },
  { key: "zoomStyle", label: "Zoom style" },
  { key: "layout", label: "Layout" },
  { key: "music", label: "Music" },
  { key: "structureType", label: "Structure" },
];

export interface ConsistencyRow {
  metric: string;
  label: string;
  kind: "numeric" | "categorical";
  reference: string;
  values: { id: string; value: string; verdict: "OK" | "MISMATCH" }[];
  verdict: "CONSISTENT" | "MISMATCH";
  note: string;
}

const fmtN = (v: number, unit: string) => `${Math.round(v * 100) / 100}${unit}`;

export function consistency(measured: Measured[], style: CreatorStyle): ConsistencyRow[] {
  const rows: ConsistencyRow[] = [];
  for (const m of NUMERIC) {
    const vals = measured.map((v) => ({ id: v.id, x: v[m.key] })).filter((v): v is { id: string; x: number } => typeof v.x === "number" && Number.isFinite(v.x));
    if (vals.length < 2) continue;
    const sorted = vals.map((v) => v.x).sort((a, b) => a - b);
    const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    const tol = Math.max(m.rel * Math.abs(med), m.abs);
    const values = vals.map((v) => ({ id: v.id, value: fmtN(v.x, m.unit), verdict: Math.abs(v.x - med) > tol ? ("MISMATCH" as const) : ("OK" as const) }));
    const bad = values.filter((v) => v.verdict === "MISMATCH");
    rows.push({
      metric: m.key,
      label: m.label,
      kind: "numeric",
      reference: `median ${fmtN(med, m.unit)} (±${fmtN(tol, m.unit)})`,
      values,
      verdict: bad.length ? "MISMATCH" : "CONSISTENT",
      note: bad.length ? `${bad.map((b) => `${b.id} ${b.value}`).join(", ")} vs median ${fmtN(med, m.unit)}` : "",
    });
  }
  for (const c of CATEGORICAL) {
    const vals = style.videos.map((v) => ({ id: v.id, x: v.observed?.[c.key] })).filter((v) => v.x !== null && v.x !== undefined && v.x !== "");
    if (vals.length < 2) continue;
    const norm = (x: unknown) => String(x).trim().toLowerCase();
    const counts = new Map<string, number>();
    for (const v of vals) counts.set(norm(v.x), (counts.get(norm(v.x)) ?? 0) + 1);
    const [major, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n * 2 <= vals.length) {
      // no majority: there is no house style to deviate from, so no single video is the odd one out
      rows.push({
        metric: c.key,
        label: c.label,
        kind: "categorical",
        reference: `varied (at most ${n}/${vals.length} agree)`,
        values: vals.map((v) => ({ id: v.id, value: String(v.x), verdict: "OK" as const })),
        verdict: "MISMATCH",
        note: "no majority across the videos: not a consistent trait of this creator",
      });
      continue;
    }
    const values = vals.map((v) => ({ id: v.id, value: String(v.x), verdict: norm(v.x) === major ? ("OK" as const) : ("MISMATCH" as const) }));
    const bad = values.filter((v) => v.verdict === "MISMATCH");
    rows.push({
      metric: c.key,
      label: c.label,
      kind: "categorical",
      reference: `${major} (${n}/${vals.length})`,
      values,
      verdict: bad.length ? "MISMATCH" : "CONSISTENT",
      note: bad.length ? `${bad.map((b) => `${b.id}: ${b.value}`).join(", ")} vs most: ${major}` : "",
    });
  }
  return rows;
}

function consistencyMd(rows: ConsistencyRow[], ids: string[]) {
  const head = `## Consistency check (${ids.length} videos)\nAdded by ReelSmith from measurements.json and the per-video observations. A value is **MISMATCH** when it is outside the\ntolerance around the median (numbers) or differs from most videos (categories). Treat MISMATCH topics as optional in a style pass.\n\n`;
  const table = [
    `| Topic | Reference | ${ids.map((id, i) => `V${i + 1}`).join(" | ")} | Verdict |`,
    `|---|---|${ids.map(() => "---").join("|")}|---|`,
    ...rows.map((r) => `| ${r.label} | ${r.reference} | ${ids.map((id) => { const v = r.values.find((x) => x.id === id); return v ? (v.verdict === "MISMATCH" ? `${v.value} **MISMATCH**` : v.value) : "–"; }).join(" | ")} | ${r.verdict === "MISMATCH" ? "**MISMATCH**" : "consistent"} |`),
  ].join("\n");
  const legend = ids.map((id, i) => `V${i + 1} = ${id}`).join(" · ");
  const bad = rows.filter((r) => r.verdict === "MISMATCH");
  const list = bad.length ? `\n\n${bad.map((r) => `- MISMATCH · ${r.label}: ${r.note}`).join("\n")}` : "\n\nAll measured topics are consistent across the videos.";
  return `${head}${table}\n\n${legend}${list}\n`;
}

/** Bump when the consistency rules change: profiles checked with older rules are re-checked when opened. */
const CONSISTENCY_VERSION = 2;

/** (Re)compute the consistency check and write it into style.json + teardown.md. false = files missing/invalid. */
function writeConsistency(dir: string, handle: string) {
  const style = creatorStyleSchema.safeParse(readJson(path.join(dir, "style.json")));
  const measured = readJson<{ videos: Measured[] }>(path.join(dir, "measurements.json"));
  if (!style.success || !measured) return false;
  const rows = consistency(measured.videos, style.data);
  writeFileSync(path.join(dir, "style.json"), JSON.stringify({ ...style.data, consistency: rows, consistencyVersion: CONSISTENCY_VERSION }, null, 1));
  const md = existsSync(path.join(dir, "teardown.md")) ? readFileSync(path.join(dir, "teardown.md"), "utf8") : `# @${handle} teardown\n\n${style.data.summary}\n`;
  const cleaned = md.replace(/\n## Consistency check[\s\S]*?(?=\n## |$)/, "").trimEnd();
  writeFileSync(path.join(dir, "teardown.md"), `${cleaned}\n\n${consistencyMd(rows, measured.videos.map((v) => v.id))}`);
  return true;
}

// ---------------------------------------------------------------- sync / read

/** Advance a teardown from its jobs: measuring -> analysing -> ready (consistency added) | failed. */
export async function syncTeardown(handle: string): Promise<ProfileMeta | null> {
  const dir = creatorFolder(handle);
  const meta = readMeta(handle);
  if (!meta) return null;
  if (meta.status === "ready" || meta.status === "failed") return meta;
  const jobs = await prisma.agentJob.findMany({ where: { id: { in: [meta.measureJobId, meta.analysisJobId].filter(Boolean) as string[] } } });
  const mj = jobs.find((j) => j.id === meta.measureJobId);
  const aj = jobs.find((j) => j.id === meta.analysisJobId);
  const fail = (j: AgentJob | undefined, what: string) => {
    const m = { ...meta, status: "failed" as const, error: `${what}: ${j?.error ?? j?.status ?? "missing"}` };
    writeMeta(dir, m);
    return m;
  };
  if (mj && (mj.status === "failed" || mj.status === "cancelled")) return fail(mj, "Download/measure");
  if (aj && (aj.status === "failed" || aj.status === "cancelled")) return fail(aj, "Style analysis");
  if (mj?.status === "done" && meta.status === "measuring") writeMeta(dir, (meta.status = "analysing", meta));
  if (aj?.status !== "done") return meta;

  if (!writeConsistency(dir, meta.handle)) return fail(aj, "style.json or measurements.json is missing or invalid");
  const done ={ ...meta, status: "ready" as const, error: null, replacing: null };
  writeMeta(dir, done);
  return done;
}

/** Every profile folder (finished or not), newest first. */
export async function listCreators() {
  const root = creatorDir();
  if (!existsSync(root)) return [];
  const out = [];
  for (const d of readdirSync(root, { withFileTypes: true }).filter((x) => x.isDirectory())) {
    let handle: string;
    try {
      handle = normHandle(d.name);
    } catch {
      continue;
    }
    const meta = (await syncTeardown(handle)) ?? null;
    const style = readJson<CreatorStyle>(path.join(root, d.name, "style.json"));
    const m = readJson<{ videos: Measured[] }>(path.join(root, d.name, "measurements.json"));
    if (!meta && !style) continue;
    const mismatches = (style?.consistency as ConsistencyRow[] | undefined)?.filter((r) => r.verdict === "MISMATCH").length ?? null;
    out.push({
      handle,
      platform: meta?.platform ?? style?.platform ?? null,
      status: meta?.status ?? (style ? "ready" : "failed"),
      error: meta?.error ?? null,
      summary: style?.summary ?? null,
      videos: m?.videos.length ?? 0,
      mismatches,
      thumb: m?.videos[0] ? ((m.videos[0].frames as Record<string, { file: string }> | undefined)?.layout?.file ?? `sheets/${m.videos[0].id}_hook.jpg`) : null,
      updatedAt: meta?.updatedAt ?? (existsSync(path.join(root, d.name, "style.json")) ? statSync(path.join(root, d.name, "style.json")).mtime.toISOString() : null),
    });
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function creatorDetail(handle: string) {
  const h = normHandle(handle);
  const dir = creatorFolder(h);
  if (!existsSync(dir)) throw new HttpError(404, `No profile for @${h}`);
  const meta = await syncTeardown(h);
  const cur = readJson<{ consistencyVersion?: number }>(path.join(dir, "style.json"));
  if (cur && cur.consistencyVersion !== CONSISTENCY_VERSION && meta?.status !== "measuring" && meta?.status !== "analysing") writeConsistency(dir, h);
  const jobs = meta ? await prisma.agentJob.findMany({ where: { id: { in: [meta.measureJobId, meta.analysisJobId].filter(Boolean) as string[] } }, orderBy: { createdAt: "asc" } }) : [];
  const measurements = readJson<{ videos: Measured[]; aggregate: unknown }>(path.join(dir, "measurements.json"));
  const style = readJson<CreatorStyle>(path.join(dir, "style.json"));
  const rows = (style?.consistency as ConsistencyRow[] | undefined) ?? [];
  const verdicts = (measurements?.videos ?? []).map((v) => {
    const bad = rows.flatMap((r) => r.values.filter((x) => x.id === v.id && x.verdict === "MISMATCH").map((x) => `${r.label}: ${x.value} (most: ${r.reference})`));
    return { id: v.id, verdict: bad.length ? ("MISMATCH" as const) : ("MATCH" as const), reasons: bad };
  });
  return {
    handle: h,
    meta,
    jobs: jobs.map(jobDTO),
    progress: readJson<{ updatedAt: string; videos: { index: number; url: string; id: string | null; title: string | null; stage: string; error: string | null }[] }>(path.join(dir, "progress.json")),
    verdicts,
    overrides: overrides(style),
    measuredStyle: readJson<CreatorStyle>(path.join(dir, "style.measured.json")),
    style,
    teardownMd: existsSync(path.join(dir, "teardown.md")) ? readFileSync(path.join(dir, "teardown.md"), "utf8") : null,
    measurements,
  };
}

export function deleteCreator(handle: string) {
  const dir = creatorFolder(handle);
  if (!existsSync(dir)) throw new HttpError(404, "No such profile");
  rmSync(dir, { recursive: true, force: true });
}

const SERVABLE: Record<string, string> = { ".jpg": "image/jpeg", ".png": "image/png", ".mp4": "video/mp4", ".json": "application/json", ".md": "text/markdown; charset=utf-8" };

/** A file inside a profile folder (sheets, videos, transcripts), path-checked. */
export function creatorFile(handle: string, rel: string) {
  const dir = creatorFolder(handle);
  const p = path.resolve(dir, rel);
  if (!p.startsWith(dir + path.sep) || !existsSync(p) || !statSync(p).isFile()) throw new HttpError(404, "File not found");
  const type = SERVABLE[path.extname(p).toLowerCase()];
  if (!type) throw new HttpError(403, "Not a servable file");
  return { path: p, type };
}

// ---------------------------------------------------------------- link check (the form validates each field live)

const SUPPORTED: { re: RegExp; site: string }[] = [
  { re: /^https:\/\/(www\.|m\.)?tiktok\.com\/@[^/]+\/video\/\d+/i, site: "TikTok" },
  { re: /^https:\/\/(vm|vt)\.tiktok\.com\/\w+/i, site: "TikTok" },
  { re: /^https:\/\/(www\.|m\.)?youtube\.com\/shorts\/[\w-]{6,}/i, site: "YouTube Shorts" },
  { re: /^https:\/\/(www\.|m\.)?youtube\.com\/watch\?.*v=[\w-]{6,}/i, site: "YouTube" },
  { re: /^https:\/\/youtu\.be\/[\w-]{6,}/i, site: "YouTube" },
];
const linkCache = new Map<string, { at: number; r: LinkCheck }>();

export interface LinkCheck {
  ok: boolean;
  level: "ok" | "warn" | "error";
  site: string | null;
  message: string;
  id?: string;
  title?: string;
  uploader?: string | null;
  durationSec?: number | null;
  thumbnail?: string | null;
}

/** Is this a public, reachable TikTok / YouTube Shorts video? (yt-dlp metadata only, nothing downloaded) */
export async function checkLink(raw: string): Promise<LinkCheck> {
  const url = raw.trim();
  if (!url) return { ok: false, level: "error", site: null, message: "Paste a link" };
  if (/instagram\.com/i.test(url))
    return { ok: false, level: "warn", site: "Instagram", message: "Instagram links usually fail (login wall). Use the creator's TikTok or YouTube Shorts version of this video." };
  if (!/^https:\/\//i.test(url)) return { ok: false, level: "error", site: null, message: "Links must start with https://" };
  const sup = SUPPORTED.find((x) => x.re.test(url));
  if (!sup) return { ok: false, level: "error", site: null, message: "Not a supported video link: use a TikTok video (tiktok.com/@user/video/...) or a YouTube Shorts link" };
  const hit = linkCache.get(url);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.r;
  const r = await new Promise<LinkCheck>((resolve) => {
    const child = spawn(workerPython(), ["-m", "yt_dlp", "--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", url], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });
    let out = "";
    let err = "";
    const kill = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      clearTimeout(kill);
      if (code !== 0) {
        const msg = (err.split(/\r?\n/).filter((l) => l.includes("ERROR")).pop() ?? err.trim().split(/\r?\n/).pop() ?? "not reachable").replace(/^ERROR:\s*/, "");
        return resolve({ ok: false, level: "error", site: sup.site, message: `Not reachable: ${msg.slice(0, 200)}` });
      }
      try {
        const j = JSON.parse(out) as { id: string; title?: string; uploader?: string; channel?: string; duration?: number; availability?: string; thumbnail?: string };
        if (j.availability && !["public", "unlisted"].includes(j.availability))
          return resolve({ ok: false, level: "error", site: sup.site, message: `The video is ${j.availability}: only public videos can be analysed` });
        const long = (j.duration ?? 0) > 180;
        resolve({
          ok: true,
          level: long ? "warn" : "ok",
          site: sup.site,
          message: long ? `Reachable, but ${Math.round(j.duration!)} s long: short-form videos teach the style better` : `${sup.site} · public · ${Math.round(j.duration ?? 0)} s`,
          id: j.id,
          title: (j.title ?? "").slice(0, 140),
          uploader: j.uploader ?? j.channel ?? null,
          durationSec: j.duration ?? null,
          thumbnail: j.thumbnail ?? null,
        });
      } catch {
        resolve({ ok: false, level: "error", site: sup.site, message: "Unexpected answer from yt-dlp" });
      }
    });
    child.on("error", (e) => resolve({ ok: false, level: "error", site: sup.site, message: `yt-dlp could not start: ${e.message}` }));
  });
  if (r.ok || /private|unavailable|removed|not exist/i.test(r.message)) linkCache.set(url, { at: Date.now(), r });
  return r;
}

// ---------------------------------------------------------------- manage

export async function cancelTeardown(handle: string) {
  const meta = readMeta(handle);
  if (!meta) throw new HttpError(404, "No such profile");
  const ids = [meta.measureJobId, meta.analysisJobId].filter(Boolean) as string[];
  await prisma.agentJob.updateMany({ where: { id: { in: ids }, status: "queued" }, data: { status: "cancelled", error: "Cancelled", finishedAt: new Date() } });
  await prisma.agentJob.updateMany({ where: { id: { in: ids }, status: "running" }, data: { cancelRequested: true } });
  writeMeta(creatorFolder(handle), { ...meta, status: "failed", error: "Cancelled" });
}

/** Re-measure only one video (a MISMATCH the user swaps for another link), then re-run the analysis. */
export async function replaceVideo(o: { userId: string; handle: string; videoId: string; url: string }) {
  const h = normHandle(o.handle);
  const dir = creatorFolder(h);
  const meta = readMeta(h);
  if (!meta || !existsSync(path.join(dir, "measurements.json"))) throw new HttpError(404, "Nothing measured for this profile yet");
  if (meta.status === "measuring" || meta.status === "analysing") throw new HttpError(409, "Wait until the current analysis finishes");
  const check = await checkLink(o.url);
  if (!check.ok) throw new HttpError(400, check.message);
  const measure = await createJob({
    userId: o.userId,
    kind: "teardown_measure",
    title: `Teardown @${h}: ${o.videoId ? `replace ${o.videoId}` : "add a video"}`,
    prompt: "(local command)",
    // no videoId: add a video (one that failed to download before), else replace that one
    exec: [workerPython(), path.join(appDir(), "worker", "teardown.py"), "--out", dir, ...(o.videoId ? ["--replace", o.videoId] : ["--add"]), "--urls", o.url.trim()],
    workDir: dir,
    timeoutSec: 30 * 60,
  });
  const analysis = await createJob({
    userId: o.userId,
    kind: "teardown",
    title: `Teardown @${h}: re-analyse`,
    prompt: analysisPrompt(h, meta.platform, dir, meta.notes, o.videoId || "a failed download"),
    outputFile: "style.json",
    schema: "creator-style",
    workDir: dir,
    afterJobId: measure.id,
    timeoutSec: 45 * 60,
  });
  writeMeta(dir, { ...meta, measureJobId: measure.id, analysisJobId: analysis.id, status: "measuring", error: null, replacing: o.videoId || null });
  return { measure: jobDTO(measure), analysis: jobDTO(analysis) };
}

function freeHandle(to: string) {
  const h = normHandle(to);
  if (existsSync(creatorFolder(h))) throw new HttpError(409, `@${h} already exists`);
  return h;
}

function retag(dir: string, handle: string) {
  const sf = path.join(dir, "style.json");
  const st = readJson<Record<string, unknown>>(sf);
  if (st) writeFileSync(sf, JSON.stringify({ ...st, handle }, null, 1));
  const m = readJson<ProfileMeta>(metaFile(dir));
  if (m) writeMeta(dir, { ...m, handle });
}

/** Rename a profile (folder + handle inside its files + projects that use it). */
export async function renameCreator(userId: string, from: string, to: string) {
  const a = normHandle(from);
  const b = freeHandle(to);
  const meta = readMeta(a);
  if (meta && (meta.status === "measuring" || meta.status === "analysing")) throw new HttpError(409, "Wait until the analysis finishes");
  renameSync(creatorFolder(a), creatorFolder(b));
  retag(creatorFolder(b), b);
  const projects = await prisma.project.findMany({ where: { userId }, select: { id: true, pipeline: true } });
  for (const p of projects) {
    const pl = p.pipeline as { creator?: string } | null;
    if (pl?.creator === a) await prisma.project.update({ where: { id: p.id }, data: { pipeline: { ...pl, creator: b } as Prisma.InputJsonValue } });
  }
  return { handle: b };
}

export function duplicateCreator(from: string, to: string) {
  const a = normHandle(from);
  const b = freeHandle(to);
  if (!existsSync(creatorFolder(a))) throw new HttpError(404, "No such profile");
  cpSync(creatorFolder(a), creatorFolder(b), { recursive: true, filter: (src) => !src.includes(`${path.sep}jobs`) });
  retag(creatorFolder(b), b);
  const m = readMeta(b);
  if (m) writeMeta(creatorFolder(b), { ...m, source: "duplicate", measureJobId: null, analysisJobId: null, createdAt: new Date().toISOString() });
  return { handle: b };
}

export function exportCreator(handle: string) {
  const dir = creatorFolder(handle);
  const files = ["teardown.md", "style.json"].filter((f) => existsSync(path.join(dir, f))).map((f) => ({ name: f, data: readFileSync(path.join(dir, f)) }));
  if (!files.length) throw new HttpError(404, "Nothing to export yet");
  return writeZip(files);
}

/** A zip with style.json (+ teardown.md) -> a ready profile. The handle comes from the form, else style.json. */
export function importCreator(userId: string, zip: Buffer, handleIn?: string | null) {
  let entries: Map<string, Buffer>;
  try {
    entries = readZip(zip);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const raw = entries.get("style.json");
  if (!raw) throw new HttpError(400, "The zip has no style.json");
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new HttpError(400, "style.json is not valid JSON");
  }
  const parsed = creatorStyleSchema.safeParse(json);
  if (!parsed.success) throw new HttpError(400, `style.json doesn't match the profile shape: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  const h = freeHandle(handleIn || parsed.data.handle);
  const dir = creatorFolder(h);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "style.json"), JSON.stringify({ ...parsed.data, handle: h }, null, 1));
  const md = entries.get("teardown.md");
  if (md) writeFileSync(path.join(dir, "teardown.md"), md);
  const now = new Date().toISOString();
  writeMeta(dir, { handle: h, platform: parsed.data.platform === "youtube" ? "youtube" : "tiktok", urls: null, notes: "", userId, measureJobId: null, analysisJobId: null, status: "ready", error: null, source: "import", createdAt: now, updatedAt: now });
  return { handle: h };
}

/** The user's edits from the style form (validated). The measured version is kept in style.measured.json. */
export function saveStyle(handle: string, next: unknown) {
  const dir = creatorFolder(handle);
  const file = path.join(dir, "style.json");
  const cur = readJson<CreatorStyle>(file);
  if (!cur) throw new HttpError(404, "No style.json yet");
  const parsed = creatorStyleSchema.safeParse({ ...(next as object), handle: normHandle(handle), consistency: cur.consistency });
  if (!parsed.success) throw new HttpError(400, `${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
  if (!existsSync(path.join(dir, "style.measured.json"))) writeFileSync(path.join(dir, "style.measured.json"), JSON.stringify(cur, null, 1));
  const measured = readJson<CreatorStyle>(path.join(dir, "style.measured.json"))!;
  const fields = diffFields(measured, parsed.data);
  const out = { ...parsed.data, edited: fields.length ? { at: new Date().toISOString(), fields } : null };
  writeFileSync(file, JSON.stringify(out, null, 1));
  return out;
}

export function resetStyle(handle: string) {
  const dir = creatorFolder(handle);
  const m = readJson<CreatorStyle>(path.join(dir, "style.measured.json"));
  if (!m) throw new HttpError(404, "Nothing to reset: the style was never edited");
  writeFileSync(path.join(dir, "style.json"), JSON.stringify({ ...m, edited: null }, null, 1));
  rmSync(path.join(dir, "style.measured.json"), { force: true });
  return m;
}

const SECTIONS = ["hooks", "pacing", "structure", "captions", "zooms", "sound", "visuals", "layout"] as const;
function diffFields(a: CreatorStyle, b: CreatorStyle) {
  const out: string[] = [];
  for (const s of SECTIONS) {
    const x = (a[s] ?? {}) as Record<string, unknown>;
    const y = (b[s] ?? {}) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (JSON.stringify(x[k] ?? null) !== JSON.stringify(y[k] ?? null)) out.push(`${s}.${k}`);
  }
  if (a.summary !== b.summary) out.push("summary");
  return out;
}

/** "Your overrides": taste rules and the creator values they replace. */
export function overrides(style: CreatorStyle | null) {
  const taste = tasteRules();
  const { topics } = resolveStyle({ taste, brand: null, creator: style });
  return {
    rules: taste,
    replaced: topics
      .filter((t) => t.winner === "taste")
      .map((t) => ({ topic: t.label, rule: t.rule ?? "", ruleText: t.value, creatorValue: t.overridden.find((o) => o.layer === "creator")?.value ?? null })),
  };
}
