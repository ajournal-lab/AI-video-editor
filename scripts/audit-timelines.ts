// Phase 2 audit harness: builds every edit mode's timeline from one source with the real mode builders
// (src/server/modes.ts), as approvePlan would after Claude's plan. Usage:
//   npx tsx --require ./scripts/lib/no-server-only.cjs scripts/audit-timelines.ts <source> <outDir> [musicFile]
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { MediaAsset } from "@prisma/client";
import { buildBestTake, buildMusic, buildShort, buildTalkingHead, buildVoiceover, type Ctx } from "../src/server/modes";
import { DESIGN_SIZE } from "../src/lib/timeline/types";

const [src, outDir, musicFile] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const info = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation:format=duration", "-of", "json", src], { encoding: "utf8" }));
const st = info.streams[0];
const rot = Math.abs(Number(st.side_data_list?.find((d: { rotation?: number }) => d.rotation !== undefined)?.rotation ?? 0)) % 180 === 90;
const [w, h] = rot ? [st.height, st.width] : [st.width, st.height];
const dur = Number(info.format.duration);
const asset = (id: string, file: string, type: string, extra: Partial<MediaAsset> = {}) =>
  ({ id, userId: "u", type, source: "upload", key: null, url: file.split(String.fromCharCode(92)).join("/"), thumbUrl: null, name: path.basename(file), mime: null, duration: dur, width: w, height: h, tags: [], meta: { hasAudio: true }, createdAt: new Date(), ...extra }) as MediaAsset;
const A = asset("src", src, "video");
const M = musicFile ? asset("music", musicFile, "music", { width: null, height: null, duration: 7.75 }) : null;
const ctx: Ctx = { aspect: "9:16", W: DESIGN_SIZE["9:16"].width, H: DESIGN_SIZE["9:16"].height, assets: new Map([["src", A], ...(M ? [["music", M] as [string, MediaAsset]] : [])]), words: new Map(), grade: null };
const cap = { y: 0.7, style: "bold" as const };
const T = Math.min(dur - 0.5, 15);

const out: Record<string, unknown> = {};
out.talking_head = buildTalkingHead({ summary: "a", script: "", sources: [{ id: "src", faceX: 0.5, faceY: 0.35 }], segments: [
  { sourceId: "src", in: 0.5, out: 4.0, text: "", include: true }, { sourceId: "src", in: 4.4, out: 8.0, text: "", include: true }, { sourceId: "src", in: 8.4, out: 12.4, text: "", include: true }],
  removed: [], captions: cap, hook: { text: "the hook", duration: 2 } }, ctx).tl;
out.best_take = buildBestTake({ summary: "a", script: "", sources: [{ id: "src", faceX: 0.5, faceY: 0.35, gainDb: 0 }], lines: [
  { text: "1", chosen: { sourceId: "src", in: 1, out: 5, score: 8 }, alternatives: [], why: "" }, { text: "2", chosen: { sourceId: "src", in: 6, out: 10.5, score: 8 }, alternatives: [], why: "" }], captions: cap }, ctx).tl;
out.voiceover_broll = buildVoiceover({ summary: "a", voiceId: "src", script: "", broll: [], segments: [
  { start: 0, end: 4, text: "", sourceId: "src", in: 0, why: "" }, { start: 4, end: 8, text: "", sourceId: "src", in: 10, why: "" }, { start: 8, end: 12, text: "", sourceId: "src", in: 3, why: "" }],
  face: { faceX: 0.5, faceY: 0.35 }, captions: cap, music: M ? { sourceId: "music", volume: 0.5 } : null }, ctx).tl;
out.music = buildMusic({ summary: "a", musicId: M ? "music" : null, musicStart: 0, shots: [
  { sourceId: "src", in: 1, out: 2.8, start: 0, end: 3, zoom: 1, cx: 0.5, cy: 0.5, grade: "grey", why: "slow-mo hook" },
  { sourceId: "src", in: 5, out: 7, start: 3, end: 5, zoom: 1.1, cx: 0.5, cy: 0.4, grade: "grey", why: "" },
  { sourceId: "src", in: 9, out: 13, start: 5, end: 9, zoom: 1.25, cx: 0.5, cy: 0.3, grade: null, why: "reveal push" }],
  texts: [{ text: "nobody saw this", start: 0, end: 3, y: 0.2, accent: true }] }, ctx, M).tl;
out.auto_clip = buildShort({ summary: "a", sourceId: "src", faceX: 0.5, faceY: 0.35, captions: cap, clips: [] }, ctx, { title: "short", start: 1, end: 1 + T, hook: "watch this", why: "", score: 9, include: true }).tl;

for (const [mode, tl] of Object.entries(out)) writeFileSync(path.join(outDir, `${mode}.json`), JSON.stringify(tl, null, 1));
console.log(JSON.stringify({ w, h, dur, modes: Object.keys(out) }));
