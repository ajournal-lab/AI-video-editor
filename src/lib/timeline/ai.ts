// AI edit operations: a Claude job writes these to ai-edit.json (validated server-side, with any new
// visuals already resolved to concrete media), and the editor applies them to its
// current timeline with applyAiOps(). The resulting JSON patch is shown as a diff
// preview before the user applies it; applying is one undoable history step.
import { clipEnd, findClip, FX_DEFAULTS, mappedWords } from "./derive";
import { zoomRoom } from "./beatfx";
import { newTextClip, TEXT_PRESETS, uid } from "./factory";
import { EMPTY_LOOKS, phraseSections, withLooks } from "./looks";
import { addClip, cutSilences, deleteClips, moveClip, removeRanges, splitAt, trimClip, updateClip } from "./ops";
import type {
  AnyClip,
  BeatFx,
  CaptionStyle,
  FilterPreset,
  FontId,
  KenBurnsDirection,
  LookId,
  TextAnimIn,
  TextAnimOut,
  Timeline,
  TransitionType,
  VisualClip,
} from "./types";

export type ResolvedVisual = Pick<
  VisualClip,
  "type" | "assetId" | "src" | "thumb" | "name" | "srcDuration" | "srcWidth" | "srcHeight" | "hasAudio" | "muted" | "keywords"
>;

export interface AiOp {
  op:
    | "cut_pauses"
    | "set_filters"
    | "set_clip"
    | "replace_visual"
    | "add_text"
    | "update_text"
    | "delete_clips"
    | "set_captions"
    | "set_music"
    | "move_clip"
    | "trim_clip"
    | "split"
    | "remove_range"
    | "zoom"
    | "add_fx"
    | "clear_fx"
    | "set_looks";
  clipIds?: string[];
  // filters
  brightness?: number;
  contrast?: number;
  saturation?: number;
  preset?: FilterPreset;
  // clip props
  speed?: number;
  volume?: number;
  muted?: boolean;
  fadeIn?: number;
  fadeOut?: number;
  kenBurns?: KenBurnsDirection | "none";
  transition?: TransitionType;
  transitionDuration?: number;
  // visuals
  query?: string;
  resolved?: Record<string, ResolvedVisual>;
  // text
  text?: string;
  textPreset?: "title" | "lower-third" | "headline";
  color?: string;
  size?: number;
  font?: FontId;
  x?: number;
  y?: number;
  animIn?: TextAnimIn;
  animOut?: TextAnimOut;
  // captions
  enabled?: boolean;
  captionStyle?: CaptionStyle;
  // music
  duck?: boolean;
  duckLevel?: number;
  // time
  start?: number;
  end?: number;
  duration?: number;
  time?: number;
  minGap?: number;
  // zoom (punch-in on clips; capped at what the source resolution allows)
  scale?: number;
  // beat/emphasis effects on the whole picture
  fx?: "punch" | "shake" | "flash";
  strength?: number;
  // looks (set_looks): look + default (the project look) | phrase (sentences saying it) | start/end; clear = all off
  look?: LookId | "none";
  default?: boolean;
  phrase?: string;
  clear?: boolean;
}

const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

function clipsOf(tl: Timeline, ids: string[] | undefined, pred: (c: AnyClip) => boolean) {
  return (ids ?? []).map((id) => findClip(tl, id)?.clip).filter((c): c is AnyClip => Boolean(c && pred(c)));
}

const isVisual = (c: AnyClip): c is VisualClip => c.type === "video" || c.type === "image" || c.type === "color";

export function applyAiOp(tl: Timeline, o: AiOp): Timeline {
  switch (o.op) {
    case "set_looks": {
      // only the settings change here; the editor rebuilds the look content (looks-hook.ts), the server before a render
      const cur = tl.looks ?? EMPTY_LOOKS;
      if (o.clear) return withLooks(tl, { default: null, sections: cur.sections.filter((s) => s.source === "script") });
      const look = o.look && o.look !== "none" ? o.look : null;
      if (o.phrase && look) return withLooks(tl, { sections: [...cur.sections, ...phraseSections(tl, o.phrase, look)] });
      if (look && o.start !== undefined && o.end !== undefined && o.end > o.start)
        return withLooks(tl, { sections: [...cur.sections, { id: uid("ls"), start: o.start, end: o.end, look, source: "chat" }] });
      return withLooks(tl, { default: look });
    }
    case "cut_pauses":
      // Models sometimes send 0 for "all pauses"; anything under 0.3s means the default.
      return cutSilences(tl, o.minGap && o.minGap >= 0.3 ? Math.min(o.minGap, 5) : 0.7).timeline;
    case "set_filters":
      for (const c of clipsOf(tl, o.clipIds, isVisual) as VisualClip[]) {
        tl = updateClip(tl, c.id, {
          filters: {
            ...c.filters,
            ...defined({
              brightness: num(o.brightness, 0.5, 1.5),
              contrast: num(o.contrast, 0.5, 1.5),
              saturation: num(o.saturation, 0, 2),
              preset: o.preset && ["none", "warm", "cool", "bw"].includes(o.preset) ? o.preset : undefined,
            }),
          },
        } as Partial<AnyClip>);
      }
      return tl;
    case "set_clip":
      for (const c of clipsOf(tl, o.clipIds, (c) => c.type !== "text")) {
        const patch: Record<string, unknown> = defined({
          speed: c.type === "video" || c.type === "audio" ? num(o.speed, 0.5, 2) : undefined,
          volume: num(o.volume, 0, 2),
          muted: typeof o.muted === "boolean" ? o.muted : undefined,
          fadeIn: num(o.fadeIn, 0, 5),
          fadeOut: num(o.fadeOut, 0, 5),
        });
        if (c.type === "image" && o.kenBurns) patch.kenBurns = o.kenBurns === "none" ? null : { direction: o.kenBurns, amount: 0.15 };
        if (isVisual(c) && o.transition)
          patch.transition = o.transition === "cut" ? null : { type: o.transition, duration: num(o.transitionDuration, 0.1, 2) ?? 0.5 };
        tl = updateClip(tl, c.id, patch as Partial<AnyClip>);
      }
      return tl;
    case "replace_visual":
      for (const c of clipsOf(tl, o.clipIds, isVisual) as VisualClip[]) {
        const r = o.resolved?.[c.id];
        if (!r) continue;
        const patch: Partial<VisualClip> = { ...r, in: 0, colors: null };
        if (r.type === "video" && r.srcDuration) patch.duration = Math.min(c.duration, r.srcDuration);
        if (r.type === "image" && !c.kenBurns) patch.kenBurns = { direction: "in", amount: 0.12 };
        if (r.type !== "image") patch.kenBurns = null;
        tl = updateClip(tl, c.id, patch as Partial<AnyClip>);
      }
      return tl;
    case "add_text": {
      const preset = o.textPreset && o.textPreset in TEXT_PRESETS ? o.textPreset : "title";
      const clip = newTextClip(preset, Math.max(0, num(o.start, 0, 36000) ?? 0), tl.aspect, o.text?.slice(0, 200) || undefined);
      if (o.duration) clip.duration = num(o.duration, 0.3, 60) ?? clip.duration;
      clip.style = { ...clip.style, ...defined({ color: o.color, size: num(o.size, 16, 300), font: o.font, x: num(o.x, 0, 1), y: num(o.y, 0, 1) }) };
      if (o.animIn) clip.animIn = o.animIn;
      if (o.animOut) clip.animOut = o.animOut;
      return addClip(tl, null, clip, "text");
    }
    case "update_text":
      for (const c of clipsOf(tl, o.clipIds, (c) => c.type === "text")) {
        if (c.type !== "text") continue;
        tl = updateClip(tl, c.id, {
          ...defined({ text: o.text, animIn: o.animIn, animOut: o.animOut }),
          style: { ...c.style, ...defined({ color: o.color, size: num(o.size, 16, 300), font: o.font, x: num(o.x, 0, 1), y: num(o.y, 0, 1) }) },
        } as Partial<AnyClip>);
      }
      return tl;
    case "delete_clips":
      return deleteClips(tl, o.clipIds ?? []);
    case "set_captions":
      return {
        ...tl,
        captions: {
          ...tl.captions,
          ...defined({
            enabled: typeof o.enabled === "boolean" ? o.enabled : undefined,
            style: o.captionStyle && ["bold", "karaoke", "minimal", "boxed"].includes(o.captionStyle) ? o.captionStyle : undefined,
            y: num(o.y, 0.05, 0.95),
            size: num(o.size, 24, 200),
          }),
        },
      };
    case "set_music": {
      let next = tl;
      if (o.duckLevel !== undefined) next = { ...next, duckLevel: num(o.duckLevel, 0, 1) ?? next.duckLevel };
      for (const t of next.tracks)
        if (t.kind === "music")
          for (const c of t.clips) next = updateClip(next, c.id, defined({ volume: num(o.volume, 0, 2), duck: o.duck }) as Partial<AnyClip>);
      return next;
    }
    case "move_clip":
      return o.clipIds?.[0] && o.start !== undefined ? moveClip(tl, o.clipIds[0], Math.max(0, o.start)) : tl;
    case "trim_clip": {
      const id = o.clipIds?.[0];
      if (!id) return tl;
      if (o.start !== undefined) tl = trimClip(tl, id, "left", o.start);
      if (o.end !== undefined) tl = trimClip(tl, id, "right", o.end);
      return tl;
    }
    case "split":
      return o.time !== undefined ? splitAt(tl, o.time, o.clipIds) : tl;
    case "remove_range":
      return o.start !== undefined && o.end !== undefined && o.end > o.start ? removeRanges(tl, [[o.start, o.end]]) : tl;
    case "zoom": {
      // punch-in: scale relative to the clip's framing, never past the source resolution (rules.md).
      // With start/end instead of clipIds: split the video clips at both ends and zoom the part in between.
      let ids = o.clipIds ?? [];
      if (!ids.length && o.start !== undefined && o.end !== undefined && o.end > o.start) {
        const vis = (t: Timeline) => t.tracks.filter((tr) => tr.kind === "video" && !tr.locked).flatMap((tr) => tr.clips as VisualClip[]).filter((c) => c.type === "video" || c.type === "image");
        for (const at of [o.start, o.end]) {
          const hit = vis(tl).filter((c) => c.start < at - 0.02 && clipEnd(c) > at + 0.02).map((c) => c.id);
          if (hit.length) tl = splitAt(tl, at, hit);
        }
        ids = vis(tl).filter((c) => c.start >= o.start! - 0.03 && clipEnd(c) <= o.end! + 0.03).map((c) => c.id);
      }
      for (const c of clipsOf(tl, ids, (c) => c.type === "video" || c.type === "image") as VisualClip[]) {
        const want = num(o.scale, 1, 1.5) ?? 1.1;
        const room = zoomRoom(tl, { ...c, transform: { ...c.transform, scale: 1 } });
        const scale = Math.round(Math.min(want, Math.max(1, room)) * 10000) / 10000;
        tl = updateClip(tl, c.id, {
          transform: { ...c.transform, scale, ...defined({ x: num(o.x, -0.5, 0.5), y: num(o.y, -0.5, 0.5) }) },
        } as Partial<AnyClip>);
      }
      return tl;
    }
    case "add_fx": {
      const type = o.fx && o.fx in FX_DEFAULTS ? o.fx : "punch";
      const d = FX_DEFAULTS[type];
      const t = num(o.time ?? o.start, 0, 36000);
      if (t === undefined) return tl;
      const fx: BeatFx = { type, t: Math.round(t * 1000) / 1000, strength: num(o.strength, 0, d.max) ?? d.strength, duration: num(o.duration, 0.05, 2) ?? d.duration };
      return { ...tl, fx: [...(tl.fx ?? []), fx].sort((a, b) => a.t - b.t) };
    }
    case "clear_fx": {
      const s0 = num(o.start, 0, 36000) ?? 0;
      const e0 = num(o.end, 0, 36000) ?? Infinity;
      return { ...tl, fx: (tl.fx ?? []).filter((f) => f.t < s0 || f.t > e0 || (o.fx !== undefined && f.type !== o.fx)) };
    }
    default:
      return tl;
  }
}

export function applyAiOps(tl: Timeline, ops: AiOp[]) {
  return ops.reduce(applyAiOp, tl);
}

/** Compact description of the timeline for the LLM: ids, timing, what's on screen, what's said. */
export function describeForAi(tl: Timeline) {
  const words = mappedWords(tl);
  const said = (s: number, e: number) =>
    words
      .filter((w) => w.start < e && w.end > s)
      .map((w) => w.text)
      .join(" ")
      .slice(0, 240);
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    aspect: tl.aspect,
    duration: r(Math.max(0, ...tl.tracks.flatMap((t) => (t.clips as AnyClip[]).map(clipEnd)))),
    captions: { enabled: tl.captions.enabled, style: tl.captions.style },
    duckLevel: tl.duckLevel,
    fx: (tl.fx ?? []).map((f) => ({ type: f.type, t: f.t, strength: f.strength })),
    tracks: tl.tracks.map((t) => ({
      id: t.id,
      kind: t.kind,
      clips: (t.clips as AnyClip[]).map((c) => {
        const base = { id: c.id, type: c.type, start: r(c.start), end: r(clipEnd(c)) };
        if (c.type === "text") return { ...base, text: c.text, preset: c.preset, y: c.style.y };
        if (c.type === "audio") return { ...base, name: c.name, volume: c.volume, muted: c.muted, duck: c.duck ?? false };
        return {
          ...base,
          scene: c.scene ?? null,
          name: c.name,
          keywords: c.keywords ?? [],
          filters: c.filters,
          transition: c.transition?.type ?? "cut",
          kenBurns: c.kenBurns?.direction ?? null,
          zoom: c.transform.scale !== 1 ? c.transform.scale : undefined,
          maxZoom: c.type === "video" || c.type === "image" ? r(zoomRoom(tl, { ...c, transform: { ...c.transform, scale: 1 } })) : undefined,
          speed: c.speed,
          said: said(c.start, clipEnd(c)),
        };
      }),
    })),
    pauses: (() => {
      const out: { at: number; length: number }[] = [];
      for (let i = 1; i < words.length; i++) {
        const g = words[i].start - words[i - 1].end;
        if (g > 0.5) out.push({ at: r(words[i - 1].end), length: r(g) });
      }
      return out;
    })(),
  };
}
