// Pure editing operations. Each takes a timeline and returns a new one (the input is
// never mutated), which is what makes unlimited undo/redo and AI-edit previews cheap.
import { clamp, clipEnd, findClip, mappedWords, timelineDuration, EPS } from "./derive";
import { newTrack, uid } from "./factory";
import type { AnyClip, AudioClip, Timeline, Track, TrackKind, VisualClip } from "./types";

export const MIN_CLIP = 0.1;

const clone = <T,>(v: T): T => structuredClone(v);

function mutate(tl: Timeline, fn: (draft: Timeline) => void): Timeline {
  const draft = clone(tl);
  fn(draft);
  return draft;
}

function sortClips(track: Track) {
  (track.clips as AnyClip[]).sort((a, b) => a.start - b.start);
}

/** Longest this clip may be at its current in-point (source-limited media). */
export function maxDuration(c: AnyClip) {
  if (c.type === "video" || c.type === "audio") {
    const src = c.srcDuration;
    if (src && src > 0) return (src - c.in) / c.speed;
  }
  return Infinity;
}

export function updateClip(tl: Timeline, id: string, patch: Partial<AnyClip>): Timeline {
  return mutate(tl, (d) => {
    const hit = findClip(d, id);
    if (!hit) return;
    Object.assign(hit.clip, patch);
    if ("speed" in patch && (hit.clip.type === "video" || hit.clip.type === "audio")) {
      hit.clip.duration = Math.min(hit.clip.duration, maxDuration(hit.clip));
    }
    sortClips(hit.track);
  });
}

export function updateTrack(tl: Timeline, id: string, patch: Partial<Pick<Track, "muted" | "hidden" | "locked" | "name">>) {
  return mutate(tl, (d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
  });
}

export function overlaps(track: Track, start: number, end: number, ignore: Set<string>) {
  return (track.clips as AnyClip[]).some((c) => !ignore.has(c.id) && c.start < end - EPS && clipEnd(c) > start + EPS);
}

const compatible = (kind: TrackKind, clip: AnyClip) =>
  (kind === "video" && (clip.type === "video" || clip.type === "image" || clip.type === "color")) ||
  ((kind === "voice" || kind === "music") && clip.type === "audio") ||
  (kind === "text" && clip.type === "text");

/**
 * Move a clip to a new start (and optionally another track of a compatible kind).
 * If it would overlap on the target track it goes to a free track of the same kind,
 * creating one when needed — so drops never destroy other clips.
 */
export function moveClip(tl: Timeline, id: string, start: number, trackId?: string): Timeline {
  return mutate(tl, (d) => {
    const hit = findClip(d, id);
    if (!hit) return;
    const clip = hit.clip;
    let target = trackId ? d.tracks.find((t) => t.id === trackId) : hit.track;
    if (!target || !compatible(target.kind, clip) || target.locked) target = hit.track;
    clip.start = Math.max(0, start);
    (hit.track.clips as AnyClip[]).splice(hit.index, 1);
    placeOnTrack(d, target, clip);
  });
}

function placeOnTrack(d: Timeline, target: Track, clip: AnyClip) {
  const ignore = new Set([clip.id]);
  let dest = target;
  if (overlaps(dest, clip.start, clipEnd(clip), ignore)) {
    const alt = d.tracks.find((t) => t.kind === target.kind && !t.locked && !overlaps(t, clip.start, clipEnd(clip), ignore));
    if (alt) dest = alt;
    else {
      const count = d.tracks.filter((t) => t.kind === target.kind).length;
      dest = newTrack(target.kind, count + 1);
      // New overlay tracks go above the target so they draw on top.
      d.tracks.splice(d.tracks.indexOf(target), 0, dest);
    }
  }
  (dest.clips as AnyClip[]).push(clip);
  sortClips(dest);
  return dest;
}

export function addClip(tl: Timeline, trackId: string | null, clip: AnyClip, kind?: TrackKind): Timeline {
  return mutate(tl, (d) => {
    let target = trackId ? d.tracks.find((t) => t.id === trackId) : undefined;
    if (!target || !compatible(target.kind, clip)) {
      const k: TrackKind = kind ?? (clip.type === "text" ? "text" : clip.type === "audio" ? "music" : "video");
      // never onto a track the looks / inserts manage (Cut-out, Inserts, Behind me, look text)
      target = d.tracks.find((t) => t.kind === k && !t.locked && !t.role);
      if (!target) {
        target = newTrack(k, 1);
        d.tracks.push(target);
      }
    }
    placeOnTrack(d, target, clip);
  });
}

export function addTrack(tl: Timeline, kind: TrackKind): Timeline {
  return mutate(tl, (d) => {
    const count = d.tracks.filter((t) => t.kind === kind).length;
    const first = d.tracks.findIndex((t) => t.kind === kind);
    const track = newTrack(kind, count + 1);
    if (first >= 0) d.tracks.splice(first, 0, track);
    else d.tracks.push(track);
  });
}

export function removeTrack(tl: Timeline, id: string): Timeline {
  return mutate(tl, (d) => {
    const t = d.tracks.find((x) => x.id === id);
    if (!t || t.kind === "captions") return;
    if (d.tracks.filter((x) => x.kind === t.kind).length <= 1 && t.clips.length > 0) return;
    d.tracks = d.tracks.filter((x) => x.id !== id);
  });
}

/** Drag a clip edge to `time` (timeline seconds). Left edge also moves the source in-point. */
export function trimClip(tl: Timeline, id: string, edge: "left" | "right", time: number): Timeline {
  return mutate(tl, (d) => {
    const hit = findClip(d, id);
    if (!hit) return;
    const c = hit.clip;
    const end = clipEnd(c);
    const media = c.type === "video" || c.type === "audio";
    if (edge === "left") {
      let minStart = 0;
      if (media) minStart = Math.max(minStart, c.start - c.in / c.speed); // can't go before source 0
      for (const o of hit.track.clips as AnyClip[]) if (o.id !== c.id && clipEnd(o) <= c.start + EPS) minStart = Math.max(minStart, clipEnd(o));
      const s = clamp(time, minStart, end - MIN_CLIP);
      if (c.type === "video" || c.type === "audio") c.in = Math.max(0, c.in + (s - c.start) * c.speed);
      c.duration = end - s;
      c.start = s;
    } else {
      let maxEnd = c.start + maxDuration(c);
      for (const o of hit.track.clips as AnyClip[]) if (o.id !== c.id && o.start >= end - EPS) maxEnd = Math.min(maxEnd, o.start);
      c.duration = clamp(time, c.start + MIN_CLIP, maxEnd) - c.start;
    }
  });
}

function splitOne(d: Timeline, id: string, t: number): string | null {
  const hit = findClip(d, id);
  if (!hit) return null;
  const c = hit.clip;
  if (t <= c.start + MIN_CLIP / 2 || t >= clipEnd(c) - MIN_CLIP / 2) return null;
  const right = clone(c);
  right.id = uid();
  const leftDur = t - c.start;
  right.start = t;
  right.duration = c.duration - leftDur;
  if (right.type === "video" || right.type === "audio") right.in = (c as VisualClip | AudioClip).in + leftDur * (c as VisualClip | AudioClip).speed;
  if (right.type === "video" || right.type === "image" || right.type === "color") {
    right.transition = null;
    right.fadeIn = 0;
  }
  if (right.type === "audio") {
    right.fadeIn = 0;
    right.keyframes = right.keyframes?.map((k) => ({ ...k, t: k.t - leftDur })).filter((k) => k.t >= 0);
  }
  if (c.type !== "text") c.fadeOut = 0;
  c.duration = leftDur;
  (hit.track.clips as AnyClip[]).splice(hit.index + 1, 0, right);
  return right.id;
}

/** Split the given clips (or every unlocked clip under the playhead) at time t. */
export function splitAt(tl: Timeline, t: number, ids?: string[]): Timeline {
  return mutate(tl, (d) => {
    const targets =
      ids && ids.length
        ? ids
        : d.tracks.filter((tr) => !tr.locked).flatMap((tr) => (tr.clips as AnyClip[]).filter((c) => c.start < t && clipEnd(c) > t).map((c) => c.id));
    for (const id of targets) splitOne(d, id, t);
  });
}

export function deleteClips(tl: Timeline, ids: string[]): Timeline {
  const set = new Set(ids);
  return mutate(tl, (d) => {
    for (const t of d.tracks) (t as { clips: AnyClip[] }).clips = (t.clips as AnyClip[]).filter((c) => !set.has(c.id));
  });
}

export function duplicateClip(tl: Timeline, id: string): { timeline: Timeline; newId: string | null } {
  const hit = findClip(tl, id);
  if (!hit) return { timeline: tl, newId: null };
  const copy = clone(hit.clip);
  copy.id = uid();
  copy.start = clipEnd(hit.clip);
  return { timeline: addClip(tl, hit.track.id, copy), newId: copy.id };
}

/**
 * Ripple delete. On the voice track it removes that time range from the whole
 * video (visuals, text, captions shift with it) because everything is cut to the
 * voice; on other tracks it closes the gap on that track only.
 */
export function rippleDelete(tl: Timeline, id: string): Timeline {
  const hit = findClip(tl, id);
  if (!hit) return tl;
  const { clip, track } = hit;
  if (track.kind === "voice") return removeRanges(tl, [[clip.start, clipEnd(clip)]]);
  const shift = clip.duration;
  return mutate(tl, (d) => {
    const t = d.tracks.find((x) => x.id === track.id)!;
    (t as { clips: AnyClip[] }).clips = (t.clips as AnyClip[])
      .filter((c) => c.id !== id)
      .map((c) => (c.start >= clipEnd(clip) - EPS ? { ...c, start: c.start - shift } : c));
  });
}

function mergeRanges(ranges: [number, number][]) {
  const sorted = ranges.filter(([a, b]) => b - a > EPS).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + EPS) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/**
 * Cut time ranges out of the whole timeline and close the gaps. Voice clips are
 * split so the audio actually loses those seconds; visual/text/music clips keep
 * their in-point and just get shorter, so pictures stay continuous. Locked tracks
 * are left alone.
 */
export function removeRanges(tl: Timeline, rangesIn: [number, number][]): Timeline {
  const ranges = mergeRanges(rangesIn);
  if (!ranges.length) return tl;
  const removedBefore = (t: number) => ranges.reduce((acc, [a, b]) => acc + Math.max(0, Math.min(b, t) - a), 0);
  const f = (t: number) => t - removedBefore(t);
  return mutate(tl, (d) => {
    for (const track of d.tracks) {
      if (track.locked) continue;
      const next: AnyClip[] = [];
      for (const c of track.clips as AnyClip[]) {
        if (track.kind === "voice" && c.type === "audio") {
          // keep the parts of the clip outside the removed ranges
          let pieces: [number, number][] = [[c.start, clipEnd(c)]];
          for (const [a, b] of ranges) {
            pieces = pieces.flatMap(([s, e]) => {
              if (b <= s || a >= e) return [[s, e]] as [number, number][];
              const keep: [number, number][] = [];
              if (a > s) keep.push([s, a]);
              if (b < e) keep.push([b, e]);
              return keep;
            });
          }
          pieces
            .filter(([s, e]) => e - s > 0.03)
            .forEach(([s, e], i) => {
              next.push({
                ...c,
                id: i === 0 ? c.id : uid(),
                start: f(s),
                duration: e - s,
                in: c.in + (s - c.start) * c.speed,
                fadeIn: i === 0 ? c.fadeIn : 0,
                fadeOut: 0,
              });
            });
          if (pieces.length) {
            const last = next[next.length - 1] as AudioClip;
            if (Math.abs(clipEnd(last) - f(clipEnd(c))) < 0.05) last.fadeOut = c.fadeOut;
          }
        } else {
          const s = f(c.start);
          const e = f(clipEnd(c));
          if (e - s < 0.05) continue;
          next.push({ ...c, start: s, duration: e - s } as AnyClip);
        }
      }
      (track as { clips: AnyClip[] }).clips = next.sort((a, b) => a.start - b.start);
    }
  });
}

/** Pauses longer than minGap between spoken words (timeline seconds), keeping `pad` of air. */
export function silenceRanges(tl: Timeline, minGap = 0.7, pad = 0.15): [number, number][] {
  const words = mappedWords(tl, false);
  const out: [number, number][] = [];
  if (!words.length) return out;
  if (words[0].start > minGap) out.push([0, words[0].start - pad]);
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > minGap) out.push([words[i - 1].end + pad, words[i].start - pad]);
  }
  // trailing silence after the last word
  const end = timelineDuration(tl);
  const lastEnd = words[words.length - 1].end;
  if (end - lastEnd > minGap + 0.5) out.push([lastEnd + 0.5, end]);
  return out;
}

export function cutSilences(tl: Timeline, minGap = 0.7) {
  const ranges = silenceRanges(tl, minGap);
  const saved = ranges.reduce((a, [s, e]) => a + (e - s), 0);
  return { timeline: removeRanges(tl, ranges), count: ranges.length, saved };
}

/** Candidate snap times: clip edges on all tracks, the playhead, and word boundaries. */
export function snapPoints(tl: Timeline, exclude: Set<string>, playhead: number): number[] {
  const pts = [0, playhead];
  for (const t of tl.tracks) for (const c of t.clips as AnyClip[]) if (!exclude.has(c.id)) pts.push(c.start, clipEnd(c));
  for (const w of mappedWords(tl, false)) pts.push(w.start, w.end);
  return pts;
}

export function snap(value: number, points: number[], threshold: number) {
  let best = value;
  let dist = threshold;
  for (const p of points) {
    const dd = Math.abs(p - value);
    if (dd < dist) {
      dist = dd;
      best = p;
    }
  }
  return { value: best, snapped: best !== value };
}
