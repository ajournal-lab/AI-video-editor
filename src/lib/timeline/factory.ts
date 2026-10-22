import { nanoid } from "nanoid";
import {
  DESIGN_SIZE,
  type Aspect,
  type AudioClip,
  type Filters,
  type TextClip,
  type TextStyle,
  type Timeline,
  type Track,
  type TrackKind,
  type Transform,
  type VisualClip,
} from "./types";

export const uid = (prefix = "c") => `${prefix}_${nanoid(8)}`;

/** Starting intensity of a look (Cinematic Warm): clearly visible, still natural. */
export const DEFAULT_GRADE_INTENSITY = 0.7;

export const DEFAULT_FILTERS: Filters = { brightness: 1, contrast: 1, saturation: 1, preset: "none" };
export const DEFAULT_TRANSFORM: Transform = { fit: "cover", scale: 1, x: 0, y: 0 };

export const CAPTION_SIZE: Record<Aspect, number> = { "9:16": 76, "1:1": 64, "16:9": 64 };

export function emptyTimeline(aspect: Aspect): Timeline {
  const { width, height } = DESIGN_SIZE[aspect];
  return {
    version: 1,
    aspect,
    width,
    height,
    fps: 30,
    background: "#000000",
    tracks: [
      { id: uid("t"), kind: "captions", name: "Captions", clips: [] },
      { id: uid("t"), kind: "text", name: "Text", clips: [] },
      { id: uid("t"), kind: "video", name: "Video", clips: [] },
      { id: uid("t"), kind: "voice", name: "Voice", clips: [] },
      { id: uid("t"), kind: "music", name: "Music", clips: [] },
    ],
    transcripts: {},
    captions: { enabled: true, style: "bold", y: aspect === "16:9" ? 0.82 : 0.72, size: CAPTION_SIZE[aspect], maxWords: 4, edits: {} },
    duckLevel: 0.2,
    audio: { autoDuck: true, sfxHeadroomDb: 6 },
  };
}

export function newTrack(kind: TrackKind, index: number): Track {
  const names: Record<TrackKind, string> = { video: "Video", voice: "Voice", music: "Music", text: "Text", captions: "Captions" };
  return { id: uid("t"), kind, name: `${names[kind]} ${index}`, clips: [] } as Track;
}

export function newVisualClip(p: Partial<VisualClip> & Pick<VisualClip, "type" | "start" | "duration">): VisualClip {
  return {
    id: uid(),
    name: p.type === "color" ? "Color" : "Clip",
    in: 0,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    transition: null,
    transform: { ...DEFAULT_TRANSFORM },
    filters: { ...DEFAULT_FILTERS },
    kenBurns: p.type === "image" ? { direction: "in", amount: 0.12 } : null,
    ...p,
  };
}

export function newAudioClip(p: Partial<AudioClip> & Pick<AudioClip, "src" | "start" | "duration">): AudioClip {
  return {
    id: uid(),
    type: "audio",
    name: "Audio",
    in: 0,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    ...p,
  };
}

export const TEXT_PRESETS: Record<
  "title" | "lower-third" | "headline",
  { label: string; text: string; duration: number; style: (aspect: Aspect) => TextStyle; animIn: TextClip["animIn"]; animOut: TextClip["animOut"] }
> = {
  title: {
    label: "Title card",
    text: "Your title",
    duration: 3,
    style: (a) => ({
      font: "montserrat",
      size: a === "16:9" ? 110 : 120,
      color: "#FFFFFF",
      background: null,
      outline: 8,
      outlineColor: "#000000",
      shadow: 0,
      uppercase: true,
      x: 0.5,
      y: a === "9:16" ? 0.2 : 0.3,
    }),
    animIn: "pop",
    animOut: "fade",
  },
  "lower-third": {
    label: "Lower third",
    text: "Name Surname\nWhat they do",
    duration: 4,
    style: (a) => ({
      font: "inter",
      size: a === "16:9" ? 48 : 52,
      color: "#111111",
      background: "#FFFFFF",
      outline: 0,
      outlineColor: "#000000",
      shadow: 0,
      uppercase: false,
      x: a === "16:9" ? 0.25 : 0.5,
      y: a === "16:9" ? 0.8 : 0.84,
    }),
    animIn: "slide-up",
    animOut: "slide-down",
  },
  headline: {
    label: "Headline",
    text: "Big idea here",
    duration: 3,
    style: () => ({
      font: "playfair",
      size: 96,
      color: "#FFFFFF",
      background: null,
      outline: 0,
      outlineColor: "#000000",
      shadow: 6,
      uppercase: false,
      x: 0.5,
      y: 0.45,
    }),
    animIn: "fade",
    animOut: "fade",
  },
};

// Rough average glyph width (em) per font, uppercase-weighted, for auto line wrapping.
const CHAR_EM: Record<TextStyle["font"], number> = { inter: 0.62, montserrat: 0.74, bebas: 0.42, playfair: 0.56, "playfair-italic": 0.52, marker: 0.62 };

/** Greedy-wrap text so each line fits ~88% of the frame width; shrink if one word is still too long. */
export function fitText(text: string, style: TextStyle, frameWidth: number): { text: string; size: number } {
  const em = CHAR_EM[style.font] * (style.uppercase ? 1.08 : 1);
  let size = style.size;
  const maxW = frameWidth * 0.88;
  const words = text.replace(/\s*\n\s*/g, " ").split(/\s+/).filter(Boolean);
  const longest = Math.max(1, ...words.map((w) => w.length));
  if (longest * em * size > maxW) size = Math.max(24, Math.floor(maxW / (longest * em)));
  const perLine = Math.max(1, Math.floor(maxW / (em * size)));
  const lines: string[] = [];
  for (const w of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && (last + " " + w).length <= perLine) lines[lines.length - 1] = last + " " + w;
    else lines.push(w);
  }
  return { text: lines.join("\n"), size };
}

export function newTextClip(preset: keyof typeof TEXT_PRESETS, start: number, aspect: Aspect, text?: string): TextClip {
  const p = TEXT_PRESETS[preset];
  const style = p.style(aspect);
  const fitted = text ? fitText(text, style, DESIGN_SIZE[aspect].width) : { text: p.text, size: style.size };
  return {
    id: uid(),
    type: "text",
    start,
    duration: p.duration,
    text: fitted.text,
    preset,
    style: { ...style, size: fitted.size },
    animIn: p.animIn,
    animOut: p.animOut,
  };
}

export const GRADIENTS: [string, string][] = [
  ["#1e1b4b", "#7c3aed"],
  ["#0f172a", "#0ea5e9"],
  ["#3b0764", "#db2777"],
  ["#052e16", "#16a34a"],
  ["#431407", "#f97316"],
  ["#172554", "#6366f1"],
];
