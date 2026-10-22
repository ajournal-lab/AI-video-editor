// Animated inserts (rules.md "Inserts"): specs, their stable hash (= one InsertJob per project), and where their clips
// go on the timeline. The worker builds them in the background (worker/inserts.py via worker/insert_pool.py).
//   Behind me track (under the Cut-out): app screen, the far side of the orbit
//   Inserts track (over everything but text): follow CTA, scrolling file, UI demo, the near side of the orbit
import { clipEnd, timelineDuration } from "./derive";
import { newVisualClip, uid } from "./factory";
import type { InsertKind, InsertRef, InsertSpec, Timeline, VideoTrack, VisualClip } from "./types";

export const INSERT_KINDS: Record<InsertKind, { label: string; blurb: string; duration: number; behind: boolean }> = {
  app_screen: { label: "App screen behind me", blurb: "Your screenshot or screen recording in a phone that slides up behind you.", duration: 4, behind: true },
  follow_cta: { label: "Follow CTA", blurb: "Your profile card; a cursor taps Follow and it turns into Following.", duration: 3.5, behind: false },
  scroll_file: { label: "Scrolling file", blurb: "A long document or screenshot scrolling top to bottom in a page.", duration: 4, behind: false },
  ui_demo: { label: "UI demo", blurb: "A UI screenshot: the cursor clicks through your tap points while the view zooms in.", duration: 5, behind: false },
  orbit: { label: "Reels orbiting me", blurb: "Your own reels circling you, passing behind and in front.", duration: 6, behind: true },
};

export const INSERTS_TRACK = "Inserts";
export const BEHIND_TRACK = "Behind me";

/** Stable JSON (sorted keys) so equal specs hash alike. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/** cyrb53 x2 -> 26 hex chars; synchronous so the editor and the server agree without crypto. */
export function specHash(spec: InsertSpec): string {
  const str = stable(spec);
  const h = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
  };
  return `${spec.kind.slice(0, 3)}${h(1)}${h(2)}`.slice(0, 31);
}

export function makeSpec(tl: Timeline, kind: InsertKind, p: Partial<InsertSpec>): InsertSpec {
  const r = (n: number) => Math.round(n * 100) / 100;
  return {
    kind,
    duration: r(Math.max(1, Math.min(20, p.duration ?? INSERT_KINDS[kind].duration))),
    width: tl.width,
    height: tl.height,
    fps: tl.fps,
    src: p.src ?? null,
    srcType: p.srcType ?? null,
    handle: p.handle ?? null,
    name: p.name ?? null,
    avatar: p.avatar ?? null,
    taps: p.taps ?? null,
    title: p.title ?? null,
    sources: p.sources ?? null,
  };
}

/** Find or create a managed video track. "Inserts" goes above every video track, "Behind me" right above the main one. */
export function insertTrack(tl: Timeline, name: typeof INSERTS_TRACK | typeof BEHIND_TRACK): VideoTrack {
  let t = tl.tracks.find((x): x is VideoTrack => x.kind === "video" && x.role === "inserts" && x.name === name);
  if (t) return t;
  t = { id: uid("t"), kind: "video", name, role: "inserts", clips: [] };
  const videos = tl.tracks.map((x, i) => ({ x, i })).filter(({ x }) => x.kind === "video");
  if (name === INSERTS_TRACK) {
    tl.tracks.splice(videos.length ? videos[0].i : tl.tracks.length, 0, t);
  } else {
    // just above the main (lowest non-background) video track: under the Cut-out and any look text
    const main = [...videos].reverse().find(({ x }) => x.name !== "Background" && !x.role) ?? videos[videos.length - 1];
    tl.tracks.splice(main ? main.i : tl.tracks.length, 0, t);
  }
  return t;
}

function insertClip(spec: InsertSpec, start: number, label: string, layer: InsertRef["layer"] = null): VisualClip {
  return newVisualClip({
    type: "video",
    start,
    duration: spec.duration,
    name: label,
    src: null,
    srcWidth: spec.width,
    srcHeight: spec.height,
    srcDuration: spec.duration,
    hasAudio: false,
    muted: true,
    volume: 0,
    insert: { kind: spec.kind, hash: specHash(spec), spec, layer },
  });
}

/** Add an insert at `start` (mutates tl). Orbit adds two clips: behind and in front of the speaker. */
export function addInsert(tl: Timeline, spec: InsertSpec, start: number) {
  const T = timelineDuration(tl);
  const s = Math.max(0, Math.min(start, Math.max(0, T - 0.5)));
  const label = INSERT_KINDS[spec.kind].label;
  const ids: string[] = [];
  if (spec.kind === "orbit") {
    const back = insertClip(spec, s, `${label} (behind)`, "back");
    const front = insertClip(spec, s, `${label} (front)`, "front");
    insertTrack(tl, BEHIND_TRACK).clips.push(back);
    insertTrack(tl, INSERTS_TRACK).clips.push(front);
    ids.push(back.id, front.id);
  } else {
    const c = insertClip(spec, s, label, INSERT_KINDS[spec.kind].behind ? "back" : null);
    insertTrack(tl, INSERT_KINDS[spec.kind].behind ? BEHIND_TRACK : INSERTS_TRACK).clips.push(c);
    ids.push(c.id);
  }
  for (const t of tl.tracks) if (t.role === "inserts") t.clips.sort((a, b) => a.start - b.start);
  return ids;
}

/** Every insert clip on the timeline. */
export function insertClips(tl: Timeline): VisualClip[] {
  return tl.tracks.flatMap((t) => (t.kind === "video" ? t.clips.filter((c) => c.insert) : []));
}

/** The specs to (re)queue: one per hash. */
export function insertSpecs(tl: Timeline): { hash: string; spec: InsertSpec }[] {
  const by = new Map<string, InsertSpec>();
  for (const c of insertClips(tl)) by.set(c.insert!.hash, c.insert!.spec);
  return [...by].map(([hash, spec]) => ({ hash, spec }));
}

/** Time ranges where something sits behind the speaker (needs the Cut-out on top). */
export function behindRanges(tl: Timeline): [number, number][] {
  return insertClips(tl)
    .filter((c) => c.insert!.layer === "back")
    .map((c) => [c.start, clipEnd(c)] as [number, number]);
}

export interface InsertStatus {
  hash: string;
  kind: InsertKind;
  status: "queued" | "processing" | "done" | "failed";
  progress: number;
  outputUrl: string | null;
  frontUrl: string | null;
  error: string | null;
  note: string | null;
}

/** The timeline with built inserts' src filled in (for the preview pool and the render snapshot). */
export function withInsertSrc(tl: Timeline, by: Record<string, Pick<InsertStatus, "status" | "outputUrl" | "frontUrl">>): Timeline {
  let changed = false;
  const tracks = tl.tracks.map((t) => {
    if (t.kind !== "video" || !t.clips.some((c) => c.insert)) return t;
    return {
      ...t,
      clips: t.clips.map((c) => {
        if (!c.insert) return c;
        const s = by[c.insert.hash];
        const src = s?.status === "done" ? (c.insert.layer === "front" ? s.frontUrl : s.outputUrl) : null;
        if ((c.src ?? null) === src) return c;
        changed = true;
        return { ...c, src };
      }),
    };
  });
  return changed ? ({ ...tl, tracks } as Timeline) : tl;
}
