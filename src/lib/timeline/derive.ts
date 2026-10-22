// Pure helpers derived from the timeline JSON. The worker (worker/timeline.py)
// implements the same math so the MP4 matches the preview. Change both together.
import type {
  AnyClip,
  AudioClip,
  BeatFx,
  CaptionSettings,
  FxType,
  Enhance,
  Filters,
  Grade,
  GradeLook,
  KenBurns,
  TextAnimIn,
  TextAnimOut,
  Timeline,
  Track,
  VisualClip,
  FontId,
  LookId,
  TextClip,
} from "./types";
import { LOOKS } from "./lookdefs";

export const clipEnd = (c: { start: number; duration: number }) => c.start + c.duration;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
export const EPS = 1e-3;

export function timelineDuration(tl: Timeline) {
  let end = 0;
  for (const t of tl.tracks) for (const c of t.clips as AnyClip[]) end = Math.max(end, clipEnd(c));
  return end;
}

export function findClip(tl: Timeline, id: string): { track: Track; clip: AnyClip; index: number } | null {
  for (const track of tl.tracks) {
    const index = (track.clips as AnyClip[]).findIndex((c) => c.id === id);
    if (index >= 0) return { track, clip: track.clips[index] as AnyClip, index };
  }
  return null;
}

/** Source seconds consumed by a video/audio clip. */
export const sourceOut = (c: { in: number; duration: number; speed: number }) => c.in + c.duration * c.speed;

// ---------------------------------------------------------------- captions

export interface TimedWord {
  id: string;
  text: string;
  start: number; // timeline seconds
  end: number;
}

/** Transcript words mapped through every visible voice clip (trim, speed, position). */
export function mappedWords(tl: Timeline, applyEdits = true): TimedWord[] {
  const out: TimedWord[] = [];
  for (const track of tl.tracks) {
    if (track.kind !== "voice" || track.hidden) continue;
    for (const clip of track.clips) {
      const words = clip.assetId ? tl.transcripts[clip.assetId]?.words : undefined;
      if (!words) continue;
      const srcEnd = sourceOut(clip);
      for (const w of words) {
        const mid = (w.start + w.end) / 2;
        if (mid < clip.in || mid >= srcEnd) continue;
        const text = applyEdits ? (tl.captions.edits[w.id] ?? w.text) : w.text;
        out.push({
          id: w.id,
          text: text.trim(),
          start: clip.start + (Math.max(w.start, clip.in) - clip.in) / clip.speed,
          end: clip.start + (Math.min(w.end, srcEnd) - clip.in) / clip.speed,
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface CaptionLine {
  start: number;
  end: number;
  words: TimedWord[];
}

export const CAPTION_MAX_CHARS: Record<Timeline["aspect"], number> = { "9:16": 20, "1:1": 24, "16:9": 36 };

export function captionLines(tl: Timeline): CaptionLine[] {
  const words = mappedWords(tl).filter((w) => w.text.length > 0);
  const maxChars = CAPTION_MAX_CHARS[tl.aspect];
  const segs = lookSegments(tl);
  const lines: CaptionLine[] = [];
  let cur: TimedWord[] = [];
  let curLook: LookId | null = null;
  const push = () => {
    if (cur.length) lines.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };
  for (const w of words) {
    const look = segLookAt(segs, w.start);
    if (cur.length) {
      const last = cur[cur.length - 1];
      const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
      // kinetic captions (Bold look) show at most 3 words at a time; a line never spans two looks
      const maxWords = look && LOOKS[look].captions === "kinetic" ? Math.min(3, tl.captions.maxWords) : tl.captions.maxWords;
      if (
        w.start - last.end > 0.6 ||
        cur.length >= maxWords ||
        chars > maxChars ||
        look !== curLook ||
        /[.!?]["')\]]?$/.test(last.text)
      )
        push();
    }
    if (!cur.length) curLook = look;
    cur.push(w);
  }
  push();
  // Hold each line until the next one when the gap is short, so captions don't flicker.
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    if (next && next.start - lines[i].end < 0.35) lines[i].end = next.start;
    else lines[i].end = next ? Math.min(lines[i].end + 0.2, next.start) : lines[i].end + 0.2;
  }
  // a look's punch line (a text clip) replaces the captions while it shows
  const punch = punchClips(tl);
  if (!punch.length) return lines;
  return lines.filter((l) => {
    const mid = (l.start + l.end) / 2;
    return !punch.some((c) => mid >= c.start && mid < clipEnd(c));
  });
}

export function punchClips(tl: Timeline): TextClip[] {
  const out: TextClip[] = [];
  for (const t of tl.tracks) if (t.kind === "text" && !t.hidden) for (const c of t.clips) if (c.role === "punch") out.push(c);
  return out;
}

// ---------------------------------------------------------------- looks (sections -> segments)

export interface LookSegment {
  start: number;
  end: number;
  look: LookId | null;
}
const LOOK_PRIORITY = { script: 1, chat: 2, timeline: 3 } as const;

/**
 * The look at every moment: dragged (timeline) sections beat chat sections beat script cues where they overlap
 * (a later section beats an earlier one of the same source); the project default fills the rest. Adjacent equal
 * pieces are merged. Empty when the timeline has no looks. Mirrors look_segments() in worker/timeline.py.
 */
export function lookSegments(tl: Timeline): LookSegment[] {
  const L = tl.looks;
  if (!L || (!L.default && !L.sections.length)) return [];
  const T = Math.max(timelineDuration(tl), ...L.sections.map((s) => s.end), 0.001);
  const cuts = [...new Set([0, T, ...L.sections.flatMap((s) => [s.start, s.end])].filter((x) => x >= 0 && x <= T).map((x) => Math.round(x * 1000) / 1000))].sort((a, b) => a - b);
  const out: LookSegment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    if (b - a < 1e-4) continue;
    const mid = (a + b) / 2;
    let best: LookId | null = null;
    let bp = 0;
    L.sections.forEach((s) => {
      if (mid < s.start || mid >= s.end) return;
      const p = LOOK_PRIORITY[s.source] ?? 1;
      if (p >= bp) [best, bp] = [s.look, p];
    });
    const look = best ?? L.default ?? null;
    const last = out[out.length - 1];
    if (last && last.look === look && Math.abs(last.end - a) < 1e-6) last.end = b;
    else out.push({ start: a, end: b, look });
  }
  return out;
}

export function segLookAt(segs: LookSegment[], t: number): LookId | null {
  for (const s of segs) if (t >= s.start && t < s.end) return s.look;
  return segs.length && t >= segs[segs.length - 1].end ? segs[segs.length - 1].look : null;
}

/** The caption style at time t: the look's captions inside a look, else the project's caption style. */
export function captionStyleAt(tl: Timeline, segs: LookSegment[], t: number): CaptionSettings["style"] {
  const look = segLookAt(segs, t);
  return look ? LOOKS[look].captions : tl.captions.style;
}

// Kinetic captions (Bold look): each line sits at the next anchor around the speaker, pops in, and its words appear
// as they are spoken. Width is estimated (the same numbers as worker/timeline.py) so both sides shrink lines alike.
export const KINETIC_ANCHORS: [number, number][] = [
  [0.3, 0.36],
  [0.7, 0.47],
  [0.31, 0.58],
  [0.69, 0.33],
  [0.3, 0.48],
  [0.7, 0.6],
];
export const KINETIC_MAX_W = 0.44; // of the frame width
export const CAPTION_REVEAL = 0.1; // s: a word fading in as it is spoken
export const CAPTION_POP = 0.15; // s: a kinetic line popping in
export const CAPTION_POP_FROM = 0.8;
const CHAR_W: Record<FontId, number> = { inter: 0.56, montserrat: 0.62, bebas: 0.4, playfair: 0.52, "playfair-italic": 0.48, marker: 0.58 };

export function estTextWidth(text: string, font: FontId, px: number, spacing = 0, upper = false) {
  return text.length * (CHAR_W[font] * (upper ? 1.12 : 1) * px + spacing);
}

/** Where kinetic line number `index` goes and how much it shrinks to fit beside the speaker. */
export function kineticPlace(line: CaptionLine, index: number, look: CaptionLook, W: number) {
  const [x, y] = KINETIC_ANCHORS[index % KINETIC_ANCHORS.length];
  const text = line.words.map((w) => w.text).join(" ");
  const est = estTextWidth(text, look.font, look.size, look.letterSpacing ?? 0, look.uppercase);
  return { x, y, scale: Math.min(1, (KINETIC_MAX_W * W) / Math.max(1, est)) };
}

/** Index of each kinetic line among the kinetic lines (anchor cycling). */
export function kineticIndex(lines: CaptionLine[], tl: Timeline, segs: LookSegment[]) {
  const idx = new Map<CaptionLine, number>();
  let n = 0;
  for (const l of lines) if (captionStyleAt(tl, segs, l.start) === "kinetic") idx.set(l, n++);
  return idx;
}

/** Index of the word being spoken in a line at time t (-1 before the first word). */
export function activeWordIndex(line: CaptionLine, t: number) {
  let idx = -1;
  for (let i = 0; i < line.words.length; i++) if (t >= line.words[i].start) idx = i;
  return idx;
}

export type WordState = "past" | "active" | "future";

export interface CaptionLook {
  font: FontId;
  size: number;
  uppercase: boolean;
  lowercase?: boolean;
  letterSpacing?: number; // px
  reveal?: boolean; // words appear as they are spoken (fade CAPTION_REVEAL)
  lineFade?: number; // s: the whole line fades in
  pop?: boolean; // the line pops in (CAPTION_POP_FROM -> 1 over CAPTION_POP)
  y?: number; // fixed centre (fraction of the height) instead of captions.y
  layout?: "line" | "kinetic";
  outline: number;
  outlineColor: string;
  shadow: number;
  box: { color: string; opacity: number; pad: number } | null;
  word: Record<WordState, { color: string; opacity: number }>;
}

export const CAPTION_PRESETS: Record<CaptionSettings["style"], { label: string; look: (size: number) => CaptionLook }> = {
  bold: {
    label: "Bold pop",
    look: (size) => ({
      font: "montserrat",
      size,
      uppercase: true,
      outline: Math.round(size * 0.09),
      outlineColor: "#000000",
      shadow: 0,
      box: null,
      word: {
        past: { color: "#FFFFFF", opacity: 1 },
        active: { color: "#FFE600", opacity: 1 },
        future: { color: "#FFFFFF", opacity: 1 },
      },
    }),
  },
  karaoke: {
    label: "Karaoke",
    look: (size) => ({
      font: "inter",
      size,
      uppercase: false,
      outline: Math.round(size * 0.07),
      outlineColor: "#000000",
      shadow: 3,
      box: null,
      word: {
        past: { color: "#4ADE80", opacity: 1 },
        active: { color: "#4ADE80", opacity: 1 },
        future: { color: "#FFFFFF", opacity: 1 },
      },
    }),
  },
  minimal: {
    label: "Minimal",
    look: (size) => ({
      font: "inter",
      size: Math.round(size * 0.8),
      uppercase: false,
      outline: 0,
      outlineColor: "#000000",
      shadow: 4,
      box: null,
      word: {
        past: { color: "#FFFFFF", opacity: 0.55 },
        active: { color: "#FFFFFF", opacity: 1 },
        future: { color: "#FFFFFF", opacity: 0.55 },
      },
    }),
  },
  kinetic: {
    label: "Kinetic (Bold look)",
    look: (size) => ({
      font: "montserrat",
      size: Math.round(size * 0.95),
      uppercase: false,
      lowercase: true,
      outline: Math.round(size * 0.07),
      outlineColor: "#000000",
      shadow: 0,
      box: null,
      reveal: true,
      pop: true,
      layout: "kinetic",
      word: {
        past: { color: "#FFFFFF", opacity: 1 },
        active: { color: "#FFFFFF", opacity: 1 },
        future: { color: "#FFFFFF", opacity: 1 }, // hidden by reveal until spoken
      },
    }),
  },
  calm: {
    label: "Calm (Cool girl look)",
    look: (size) => ({
      font: "inter",
      size: Math.round(size * 0.62),
      uppercase: false,
      lowercase: true,
      outline: 0,
      outlineColor: "#000000",
      shadow: 3,
      box: null,
      lineFade: 0.25,
      y: 0.7,
      word: {
        past: { color: "#FFFFFF", opacity: 1 },
        active: { color: "#FFFFFF", opacity: 1 },
        future: { color: "#FFFFFF", opacity: 1 },
      },
    }),
  },
  editorial: {
    label: "Editorial (Cool dude look)",
    look: (size) => ({
      font: "inter",
      size: Math.round(size * 0.4),
      uppercase: true,
      letterSpacing: Math.round(size * 0.4 * 0.32),
      outline: 0,
      outlineColor: "#000000",
      shadow: 2,
      box: null,
      lineFade: 0.2,
      y: 0.78,
      word: {
        past: { color: "#FFFFFF", opacity: 0.92 },
        active: { color: "#FFFFFF", opacity: 0.92 },
        future: { color: "#FFFFFF", opacity: 0.92 },
      },
    }),
  },
  boxed: {
    label: "Boxed",
    look: (size) => ({
      font: "bebas",
      size: Math.round(size * 1.15),
      uppercase: true,
      outline: 0,
      outlineColor: "#000000",
      shadow: 0,
      box: { color: "#000000", opacity: 0.7, pad: Math.round(size * 0.22) },
      word: {
        past: { color: "#FFFFFF", opacity: 1 },
        active: { color: "#F43F5E", opacity: 1 },
        future: { color: "#FFFFFF", opacity: 1 },
      },
    }),
  },
};

// ---------------------------------------------------------------- audio

/** Merged speech intervals (timeline seconds) of unmuted voice clips; used for ducking. */
export function speechIntervals(tl: Timeline): [number, number][] {
  const mutedTracks = new Set(tl.tracks.filter((t) => t.kind === "voice" && t.muted).map((t) => t.id));
  const mutedClips = new Set<string>();
  for (const t of tl.tracks) if (t.kind === "voice") for (const c of t.clips) if (c.muted || mutedTracks.has(t.id)) mutedClips.add(c.id);
  const tmp: Timeline = {
    ...tl,
    tracks: tl.tracks
      .filter((t) => t.kind === "voice" && !mutedTracks.has(t.id))
      .map((t) => ({ ...t, hidden: false, clips: (t.clips as AudioClip[]).filter((c) => !mutedClips.has(c.id)) })) as Track[],
  };
  const words = mappedWords(tmp, false);
  const out: [number, number][] = [];
  for (const w of words) {
    const last = out[out.length - 1];
    if (last && w.start - last[1] < 0.6) last[1] = Math.max(last[1], w.end);
    else out.push([w.start, w.end]);
  }
  return out;
}

export const DUCK_RAMP = 0.25;

// Audio safety (rules.md): music ducks under the voice by default; sound effects never duck, they are kept
// sfxHeadroomDb below the voice instead (worker/audio_safety.py measures and turns down louder ones).
export const AUDIO_DEFAULTS = { autoDuck: true, sfxHeadroomDb: 6 };
export const audioSafety = (tl: Timeline) => ({ ...AUDIO_DEFAULTS, ...(tl.audio ?? {}) });
/** Does this music-track clip duck under the voice? (worker/timeline.py clip_ducks) */
export const clipDucks = (tl: Timeline, c: AudioClip) => !c.sfx && (c.duck ?? audioSafety(tl).autoDuck);
/** Short sounds dropped on a music track count as sound effects. */
export const SFX_MAX_SECONDS = 8;

/** Ducking multiplier at timeline time t: duckLevel inside speech, 1 far from it, linear ramps. */
export function duckGain(intervals: [number, number][], duckLevel: number, t: number) {
  let m = 0;
  for (const [a, b] of intervals) {
    const v = clamp(Math.min((t - (a - DUCK_RAMP)) / DUCK_RAMP, (b + DUCK_RAMP - t) / DUCK_RAMP), 0, 1);
    if (v > m) m = v;
  }
  return 1 - (1 - duckLevel) * m;
}

export function keyframeGain(clip: AudioClip, local: number) {
  const kfs = clip.keyframes;
  if (!kfs || kfs.length === 0) return 1;
  const k = [...kfs].sort((a, b) => a.t - b.t);
  if (local <= k[0].t) return k[0].gain;
  for (let i = 1; i < k.length; i++) {
    if (local <= k[i].t) {
      const span = k[i].t - k[i - 1].t || 1;
      return k[i - 1].gain + ((k[i].gain - k[i - 1].gain) * (local - k[i - 1].t)) / span;
    }
  }
  return k[k.length - 1].gain;
}

/** Linear fade multiplier for a clip at timeline time t. */
export function fadeGain(c: { start: number; duration: number; fadeIn: number; fadeOut: number }, t: number) {
  let g = 1;
  if (c.fadeIn > 0) g = Math.min(g, clamp((t - c.start) / c.fadeIn, 0, 1));
  if (c.fadeOut > 0) g = Math.min(g, clamp((clipEnd(c) - t) / c.fadeOut, 0, 1));
  return g;
}

// ---------------------------------------------------------------- color

type M3 = [number, number, number, number, number, number, number, number, number];

const PRESET_MATRIX: Record<Filters["preset"], M3> = {
  none: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  warm: [1.06, 0.04, 0, 0.02, 1.0, 0, 0, 0, 0.84],
  cool: [0.88, 0, 0.02, 0, 0.98, 0.04, 0, 0.04, 1.12],
  bw: [0.299, 0.587, 0.114, 0.299, 0.587, 0.114, 0.299, 0.587, 0.114],
};

function mul(a: M3, b: M3): M3 {
  const r = new Array(9).fill(0) as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

/**
 * Color pipeline: v' = clip(v * slope + intercept) per channel (brightness, then contrast),
 * then a 3x3 matrix (saturation, then preset). Preview: SVG feComponentTransfer +
 * feColorMatrix; render: lutrgb + colorchannelmixer.
 */
export function colorOps(f: Filters) {
  const s = f.saturation;
  const sat: M3 = [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
  ];
  const matrix = mul(PRESET_MATRIX[f.preset], sat);
  return {
    slope: f.brightness * f.contrast,
    intercept: 0.5 * (1 - f.contrast),
    matrix,
    identity:
      Math.abs(f.brightness - 1) < 1e-3 && Math.abs(f.contrast - 1) < 1e-3 && Math.abs(s - 1) < 1e-3 && f.preset === "none",
  };
}

/** Combined Enhance color+match curve per channel: y = clip(((x-lo)/(hi-lo))^(1/gamma) * gain). Mirrors curve() in worker/enhance.py. */
export function enhanceCurve(e: Enhance | null | undefined) {
  const c = e?.color?.on ? e.color : null;
  const m = e?.match?.on ? e.match : null;
  if (!c && !m) return null;
  const gm = m?.gamma ?? 1;
  const kc = c?.gains ?? [1, 1, 1];
  const km = m?.gains ?? [1, 1, 1];
  const lo = c?.lo ?? 0;
  return {
    lo,
    hi: Math.max(c?.hi ?? 1, lo + 0.05),
    gamma: (c?.gamma ?? 1) * gm,
    gains: [0, 1, 2].map((i) => kc[i] ** (1 / gm) * km[i]) as [number, number, number],
  };
}

/** SVG feFunc tableValues (n samples) for one channel of an enhance curve. */
export function enhanceTable(cv: NonNullable<ReturnType<typeof enhanceCurve>>, ch: 0 | 1 | 2, n = 33) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const y = Math.min(1, Math.max(0, (x - cv.lo) / (cv.hi - cv.lo))) ** (1 / cv.gamma) * cv.gains[ch];
    out.push(Math.round(Math.min(1, Math.max(0, y)) * 10000) / 10000);
  }
  return out;
}

// ---------------------------------------------------------------- grade (looks)

/** Mirrors LOOKS in worker/grade.py. The render applies a 3D LUT (incl. skin protection); the preview uses the
 * per-channel tone curve, a global saturation cut for the background desaturation, and the same vignette. */
export const GRADE_LOOKS = {
  cinematic_warm: {
    label: "Cinematic Warm",
    contrast: 0.25,
    lift: 0.035,
    roll: 0.975,
    shadows: [-0.025, 0.008, 0.03],
    highlights: [0.045, 0.012, -0.04],
    bgDesat: 0.25,
    vignette: 0.3,
  },
  warm_soft: { label: "Warm Soft", contrast: 0.08, lift: 0.05, roll: 0.97, shadows: [0.02, 0.008, -0.012], highlights: [0.05, 0.02, -0.045], bgDesat: 0.08, vignette: 0.15 },
  dark_editorial: { label: "Dark Editorial", contrast: 0.3, lift: 0.012, roll: 0.8, shadows: [-0.012, 0, 0.012], highlights: [0, 0, -0.012], bgDesat: 0.35, vignette: 0.6 },
  editorial_subject: { label: "Editorial (speaker)", contrast: 0.22, lift: 0.02, roll: 0.99, shadows: [0, 0, 0.01], highlights: [0.02, 0.01, -0.01], bgDesat: 0.15, vignette: 0 },
} as const satisfies Record<GradeLook, unknown>;
export const GRADE_VIGNETTE = { r0: 0.45, r1: 1.05 };

/** Per-channel tone curve at intensity k (worker/grade.py tone(), blended toward identity). */
export function gradeTable(g: Grade, ch: 0 | 1 | 2, n = 33) {
  const L = GRADE_LOOKS[g.look];
  const k = clamp(g.intensity, 0, 1);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const sx = x - (L.contrast * Math.sin(2 * Math.PI * x)) / (2 * Math.PI);
    const y = clamp(L.lift + (L.roll - L.lift) * sx + L.shadows[ch] * (1 - x) ** 2 + L.highlights[ch] * x ** 2, 0, 1);
    out.push(Math.round(clamp(x + k * (y - x), 0, 1) * 10000) / 10000);
  }
  return out;
}

/** Preview approximation of the background desaturation (skin is protected in the render only). */
export const gradeSaturation = (g: Grade) => 1 - GRADE_LOOKS[g.look].bgDesat * clamp(g.intensity, 0, 1) * 0.6;

/** Vignette darkening (0..1) at radius r (fraction of the half-diagonal); as vignette_alpha() in grade.py. */
export function gradeVignetteAt(g: Grade, r: number) {
  return GRADE_LOOKS[g.look].vignette * clamp(g.intensity, 0, 1) * smoothstep(GRADE_VIGNETTE.r0, GRADE_VIGNETTE.r1, r);
}

export const hasGrade = (g: Grade | null | undefined): g is Grade => !!g && g.look in GRADE_LOOKS && g.intensity > 0.005;

// ---------------------------------------------------------------- motion

/** Ken Burns window at progress p (0..1): zoom z, and window position fx/fy (0..1 of free space). */
export function kenBurnsAt(kb: KenBurns, p: number) {
  const a = kb.amount;
  switch (kb.direction) {
    case "in":
      return { z: 1 + a * p, fx: 0.5, fy: 0.5 };
    case "out":
      return { z: 1 + a * (1 - p), fx: 0.5, fy: 0.5 };
    case "left":
      return { z: 1 + a, fx: 1 - p, fy: 0.5 };
    case "right":
      return { z: 1 + a, fx: p, fy: 0.5 };
    case "up":
      return { z: 1 + a, fx: 0.5, fy: 1 - p };
    case "down":
      return { z: 1 + a, fx: 0.5, fy: p };
  }
}

export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// Sparkles around a text clip (style.sparkles, the Cool girl punch line): four-point stars at the corners of the
// estimated text box that twinkle (triangle wave, half period SPARKLE_HALF s). worker/ass.py draws the same stars.
export const SPARKLE_HALF = 0.45;
export const SPARKLE_COLOR = "#FFF3B0";
export const SPARKLES = [
  { dx: -1, dy: -1, ox: -28, oy: -6, size: 34, phase: 0 },
  { dx: 1, dy: -1, ox: 26, oy: 2, size: 24, phase: 1 },
  { dx: 1, dy: 1, ox: 14, oy: 10, size: 28, phase: 0 },
  { dx: -1, dy: 1, ox: -10, oy: 14, size: 20, phase: 1 },
] as const;
/** ASS drawing of the star (40 units across); the canvas traces the same path. */
export const STAR_PATH = "m 0 -20 b 3 -3 3 -3 20 0 b 3 3 3 3 0 20 b -3 3 -3 3 -20 0 b -3 -3 -3 -3 0 -20";
/** Twinkle level 0..1 of a star at `local` seconds into the clip. */
export function sparkleLevel(local: number, phase: number) {
  const u = Math.max(0, local) / SPARKLE_HALF + phase;
  const k = Math.floor(u);
  const f = u - k;
  return k % 2 === 0 ? 1 - f : f;
}
export const sparkleAlpha = (v: number) => 0.25 + 0.75 * v;
export const sparkleScale = (v: number) => 0.6 + 0.4 * v;
/** Centre offsets (px) of the stars around a text box of half-size hw x hh. */
export const sparkleSpots = (hw: number, hh: number) => SPARKLES.map((s) => ({ ...s, x: s.dx * hw + s.ox, y: s.dy * hh + s.oy }));

export const TEXT_ANIM = 0.4;
export const TEXT_SLIDE_PX = 60;
export const TEXT_POP_FROM = 0.6;

/** Text animation state at timeline time t: opacity, vertical offset (px), scale. */
export function textAnimState(
  c: { start: number; duration: number; animIn: TextAnimIn; animOut: TextAnimOut },
  t: number,
) {
  const d = Math.min(TEXT_ANIM, c.duration / 3);
  let alpha = 1,
    dy = 0,
    scale = 1;
  const pin = clamp((t - c.start) / d, 0, 1);
  const pout = clamp((clipEnd(c) - t) / d, 0, 1);
  if (c.animIn !== "none" && pin < 1) {
    alpha = pin;
    if (c.animIn === "slide-up") dy = TEXT_SLIDE_PX * (1 - pin);
    if (c.animIn === "pop") scale = TEXT_POP_FROM + (1 - TEXT_POP_FROM) * pin;
  }
  if (c.animOut !== "none" && pout < 1) {
    alpha = Math.min(alpha, pout);
    if (c.animOut === "slide-down") dy = TEXT_SLIDE_PX * (1 - pout);
    if (c.animOut === "pop") scale = TEXT_POP_FROM + (1 - TEXT_POP_FROM) * pout;
  }
  return { alpha, dy, scale };
}

// ---------------------------------------------------------------- beat effects
// worker/timeline.py fx_exprs() writes the same formulas as ffmpeg expressions (perspective + eq). u = (t - fx.t) / duration.
//   punch: zoom += s(1-u)^2      shake: zoom += 2.2 s (1-u), dx += s(1-u) sin(2pi 17 (t-t0)), dy += 0.7 s(1-u) sin(2pi 11 (t-t0) + 1.3)
//   flash: brightness += s(1-u)^2
// dx/dy are fractions of the frame, clamped to the room the zoom leaves, so the frame edge never shows.
export const FX_SHAKE = { zoom: 2.2, fx: 17, fy: 11, ky: 0.7, phase: 1.3 } as const;
export const FX_DEFAULTS: Record<FxType, { strength: number; duration: number; max: number }> = {
  punch: { strength: 0.08, duration: 0.3, max: 0.3 },
  shake: { strength: 0.015, duration: 0.35, max: 0.05 },
  flash: { strength: 0.5, duration: 0.2, max: 1 },
};

/** Zoom, offset (fractions of the frame) and added brightness of the beat effects at timeline time t. */
export function fxAt(fx: BeatFx[] | undefined, t: number) {
  let zs = 0,
    dx = 0,
    dy = 0,
    flash = 0;
  for (const e of fx ?? []) {
    const r = t - e.t;
    if (r < 0 || r >= e.duration) continue;
    const v = 1 - r / e.duration;
    if (e.type === "punch") zs += e.strength * v * v;
    else if (e.type === "flash") flash += e.strength * v * v;
    else {
      zs += FX_SHAKE.zoom * e.strength * v;
      dx += e.strength * v * Math.sin(2 * Math.PI * FX_SHAKE.fx * r);
      dy += FX_SHAKE.ky * e.strength * v * Math.sin(2 * Math.PI * FX_SHAKE.fy * r + FX_SHAKE.phase);
    }
  }
  const z = 1 + zs;
  const room = (1 - 1 / z) / 2;
  return { z, dx: clamp(dx, -room, room), dy: clamp(dy, -room, room), flash: Math.min(1, flash) };
}

/** xfade fadewhite at progress p (0 = previous clip, 1 = this clip): weights of the previous clip, this clip and white. */
export function fadeWhiteWeights(p: number) {
  const P = 1 - p; // xfade's progress runs 1 -> 0
  const wA = P * smoothstep(0.8, 1, P);
  const wB = (1 - P) * (1 - smoothstep(0.2, 1, P));
  return { wA, wB, wW: Math.max(0, 1 - wA - wB) };
}

/** Previous clip on the same track that ends where `clip` starts (for transitions). */
export function adjacentPrev(clips: VisualClip[], clip: VisualClip) {
  let best: VisualClip | null = null;
  for (const c of clips) if (c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < 0.05) best = c;
  return best;
}

/** Placement of a source (sw x sh) into a W x H frame: drawn size and top-left. */
export function placement(sw: number, sh: number, W: number, H: number, tr: VisualClip["transform"]) {
  const base = tr.fit === "cover" ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  const w = sw * base * tr.scale;
  const h = sh * base * tr.scale;
  return { w, h, x: W / 2 + tr.x * W - w / 2, y: H / 2 + tr.y * H - h / 2 };
}
