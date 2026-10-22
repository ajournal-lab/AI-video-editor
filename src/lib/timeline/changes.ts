// "What changed" between two timelines, in words: the auto-notes of a numbered render version (v3 vs v2) and the
// compare view. Pure; compares by clip id, so a trim reads as a trim and a split as an added clip.
import { clipEnd, timelineDuration } from "./derive";
import { LOOKS } from "./lookdefs";
import type { AnyClip, Timeline } from "./types";

const r1 = (n: number) => Math.round(n * 10) / 10;
const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) < eps;

function clipsById(tl: Timeline) {
  const out = new Map<string, { clip: AnyClip; kind: string }>();
  for (const t of tl.tracks) for (const c of t.clips as AnyClip[]) out.set(c.id, { clip: c, kind: t.kind });
  return out;
}

const NOUN: Record<string, string> = { video: "clip", voice: "voice clip", music: "music clip", text: "text" };

/** Short bullet lines (most important first), empty when nothing visible changed. */
export function describeChanges(prev: Timeline | null, next: Timeline): string[] {
  if (!prev) return ["First version"];
  const out: string[] = [];
  const dPrev = timelineDuration(prev);
  const dNext = timelineDuration(next);
  if (!near(dPrev, dNext, 0.1)) out.push(`Length ${r1(dPrev)}s → ${r1(dNext)}s`);

  const a = clipsById(prev);
  const b = clipsById(next);
  const count = (m: Map<string, unknown>) => m.size;
  const added: Record<string, number> = {};
  const removed: Record<string, number> = {};
  let moved = 0,
    trimmed = 0,
    restyled = 0,
    retext = 0;
  for (const [id, { clip, kind }] of b) {
    const old = a.get(id);
    if (!old) {
      if (!(clip as { gen?: string }).gen) added[kind] = (added[kind] ?? 0) + 1;
      continue;
    }
    const o = old.clip;
    if (!near(o.start, clip.start)) moved++;
    else if (!near(o.duration, clip.duration) || ("in" in o && "in" in clip && !near(o.in, clip.in))) trimmed++;
    if (clip.type === "text" && o.type === "text" && clip.text !== o.text) retext++;
    if (JSON.stringify({ ...o, start: 0, duration: 0, in: 0, text: "" }) !== JSON.stringify({ ...clip, start: 0, duration: 0, in: 0, text: "" })) restyled++;
  }
  for (const [id, { clip, kind }] of a) if (!b.has(id) && !(clip as { gen?: string }).gen) removed[kind] = (removed[kind] ?? 0) + 1;
  const list = (m: Record<string, number>) => Object.entries(m).map(([k, n]) => `${n} ${NOUN[k] ?? k}${n > 1 ? "s" : ""}`).join(", ");
  if (Object.keys(added).length) out.push(`Added ${list(added)}`);
  if (Object.keys(removed).length) out.push(`Removed ${list(removed)}`);
  if (moved) out.push(`Moved ${moved} clip${moved > 1 ? "s" : ""}`);
  if (trimmed) out.push(`Trimmed ${trimmed} clip${trimmed > 1 ? "s" : ""}`);
  if (retext) out.push(`Rewrote ${retext} text${retext > 1 ? "s" : ""}`);
  if (restyled > retext) out.push(`Restyled ${restyled - retext} clip${restyled - retext > 1 ? "s" : ""} (zoom, colour, effects…)`);

  const lp = prev.looks;
  const ln = next.looks;
  if ((lp?.default ?? null) !== (ln?.default ?? null)) out.push(`Default look: ${lookName(lp?.default)} → ${lookName(ln?.default)}`);
  const sp = JSON.stringify(lp?.sections ?? []);
  const sn = JSON.stringify(ln?.sections ?? []);
  if (sp !== sn) {
    const secs = (ln?.sections ?? []).map((s) => `${lookName(s.look)} ${r1(s.start)}–${r1(s.end)}s`);
    out.push(secs.length ? `Look sections: ${secs.join(", ")}` : "Look sections removed");
  }

  if (prev.captions.enabled !== next.captions.enabled) out.push(next.captions.enabled ? "Captions on" : "Captions off");
  else if (prev.captions.style !== next.captions.style) out.push(`Captions ${prev.captions.style} → ${next.captions.style}`);
  const ed = Object.keys(next.captions.edits).length - Object.keys(prev.captions.edits).length;
  if (ed) out.push(`${Math.abs(ed)} caption word${Math.abs(ed) > 1 ? "s" : ""} ${ed > 0 ? "edited" : "restored"}`);
  if ((prev.fx?.length ?? 0) !== (next.fx?.length ?? 0)) out.push(`Beat effects ${prev.fx?.length ?? 0} → ${next.fx?.length ?? 0}`);
  if (!near(prev.duckLevel, next.duckLevel, 0.01)) out.push(`Music under the voice ${Math.round(prev.duckLevel * 100)}% → ${Math.round(next.duckLevel * 100)}%`);
  const ins = (tl: Timeline) => tl.tracks.flatMap((t) => (t.kind === "video" ? t.clips.filter((c) => c.insert) : [])).length;
  if (ins(prev) !== ins(next)) out.push(`Inserts ${ins(prev)} → ${ins(next)}`);
  if (!out.length && count(a) === count(b)) {
    const ends = (tl: Timeline) => tl.tracks.flatMap((t) => (t.clips as AnyClip[]).map(clipEnd));
    if (JSON.stringify(ends(prev)) === JSON.stringify(ends(next)) && JSON.stringify(prev) === JSON.stringify(next)) return ["Same edit as the previous version (re-render)"];
    out.push("Small changes");
  }
  return out;
}

const lookName = (id: string | null | undefined) => (id && id in LOOKS ? LOOKS[id as keyof typeof LOOKS].label : "none");
