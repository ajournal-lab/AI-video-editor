// Look presets (rules.md "Looks"): Bold / Cool girl / Cool dude, a project default and per-section switches.
// applyLooks() is pure and deterministic: it removes everything a previous run generated (clips with gen: "look",
// the Cut-out / look text tracks, grades and crops it set) and builds it again from the base edit + tl.looks. The
// editor runs it whenever the base edit or the look settings change (no undo step of its own), the server before a
// render. Mattes for the speaker cut-out are reused when they cover the same source window, otherwise listed in
// `needsMatte` for the caller to queue (worker/matte.py).
import { captionLines, clipEnd, lookSegments, mappedWords, timelineDuration, type LookSegment, type TimedWord } from "./derive";
import { newTextClip, uid } from "./factory";
import { addInsert, BEHIND_TRACK, INSERTS_TRACK, makeSpec } from "./inserts";
import { LOOKS, parseLookName, PUNCH_COLOR } from "./lookdefs";
import { matteCovers } from "./matte";
import { splitAt } from "./ops";
import type { LookId, LookSection, Looks, Matte, TextClip, TextStyle, TextTrack, Timeline, Track, VideoTrack, VisualClip } from "./types";

export const CUTOUT_TRACK = "Cut-out";
export const LOOK_TEXT = "Look text";
export const LOOK_BEHIND = "Look text · behind";
export const EMPTY_LOOKS: Looks = { default: null, sections: [], autoScript: true };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------- base (the edit without generated content)

const isMainVideo = (t: Track): t is VideoTrack => t.kind === "video" && !t.role && t.name !== "Background";

/** The timeline minus everything applyLooks made: the "base" a hash compares and the next run starts from. */
export function stripLooks(tl: Timeline): Timeline {
  const d = clone(tl);
  d.tracks = d.tracks.filter((t) => t.role !== "cutout" && t.role !== "look");
  for (const t of d.tracks) {
    (t as { clips: unknown[] }).clips = (t.clips as { gen?: string | null }[]).filter((c) => c.gen !== "look");
    if (t.kind === "video")
      for (const c of t.clips) {
        if (c.lookOrig) {
          c.grade = c.lookOrig.grade;
          c.transform = c.lookOrig.transform;
        }
        delete c.lookOrig;
        delete c.lookCrop;
      }
  }
  // an emptied "Behind me" / "Inserts" track that only held look inserts goes too
  d.tracks = d.tracks.filter((t) => !(t.role === "inserts" && t.clips.length === 0));
  if (d.looks) d.looks = { ...d.looks, punchWords: [], applied: null, notes: [] };
  return d;
}

/** Stable hash of what the looks are built from (the base edit + the look settings), to know when to rebuild. */
export function looksKey(tl: Timeline): string {
  const b = stripLooks(tl);
  const { transcripts: _t, ...rest } = b; // eslint-disable-line @typescript-eslint/no-unused-vars
  const L = b.looks ? { default: b.looks.default, sections: b.looks.sections, autoScript: b.looks.autoScript, softCloseups: b.looks.softCloseups ?? false, orbitSources: b.looks.orbitSources ?? null } : null;
  const s = JSON.stringify({ ...rest, looks: L, words: Object.keys(tl.transcripts).sort() });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return `${(h >>> 0).toString(16)}-${s.length}`;
}

export const looksStale = (tl: Timeline) => Boolean(tl.looks) && tl.looks!.applied !== looksKey(tl);

// ---------------------------------------------------------------- script cues

const CUE = /^(bold|cool|that)$/;

/** Spoken look switches ("cool girl aesthetic", "bold look", "cool dude", "editorial look"): one script section per cue, from the cue's sentence to the next cue. */
export function detectScriptCues(tl: Timeline): LookSection[] {
  const words = mappedWords(tl, false);
  const T = timelineDuration(tl);
  const norm = (w: TimedWord) => w.text.toLowerCase().replace(/[^a-z]/g, "");
  const hits: { at: number; look: LookId; cue: string }[] = [];
  for (let i = 0; i < words.length; i++) {
    const a = norm(words[i]);
    if (!CUE.test(a) && a !== "editorial") continue;
    const b = words[i + 1] ? norm(words[i + 1]) : "";
    const c = words[i + 2] ? norm(words[i + 2]) : "";
    let look: LookId | null = null;
    let n = 1;
    if (a === "cool" && (b === "girl" || b === "dude" || b === "guy")) {
      look = parseLookName(a + b);
      n = /^(aesthetic|look|style|vibe|mode|era|energy)$/.test(c) ? 3 : 2;
    } else if (a === "that" && b === "girl" && /^(aesthetic|look|vibe|era)$/.test(c)) {
      look = "cool_girl";
      n = 3;
    } else if ((a === "bold" || a === "editorial") && /^(look|style|aesthetic|mode)$/.test(b)) {
      look = a === "bold" ? "bold" : "cool_dude";
      n = 2;
    }
    if (!look) continue;
    // the switch starts at the sentence the cue is in
    let s = i;
    while (s > 0 && !/[.!?]["')\]]?$/.test(words[s - 1].text) && words[s].start - words[s - 1].end < 0.6) s--;
    hits.push({ at: words[s].start, look, cue: words.slice(i, i + n).map((w) => w.text).join(" ") });
    i += n - 1;
  }
  return hits.map((h, k) => ({ id: `cue${k}`, start: r3(h.at), end: r3(hits[k + 1]?.at ?? Math.max(T, h.at + 0.5)), look: h.look, source: "script" as const, cue: h.cue }));
}

// ---------------------------------------------------------------- sentences & punch words

export interface Sentence {
  start: number;
  end: number;
  words: TimedWord[];
}

/** Spoken sentences (punctuation, or a pause over 0.6 s). */
export function sentences(tl: Timeline): Sentence[] {
  const words = mappedWords(tl).filter((w) => w.text);
  const out: Sentence[] = [];
  let cur: TimedWord[] = [];
  for (const w of words) {
    if (cur.length && w.start - cur[cur.length - 1].end > 0.6) {
      out.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
      cur = [];
    }
    cur.push(w);
    if (/[.!?]["')\]]?$/.test(w.text)) {
      out.push({ start: cur[0].start, end: w.end, words: cur });
      cur = [];
    }
  }
  if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
  return out;
}

const STOP = new Set(
  "a an the and or but so to of in on at for with from by is are was were be been am i you he she it we they me my your our their this that these those do does did have has had not no yes just very really like um uh im its dont cant wont youre thats theres what when where who how about into than then there here up out over more most can will would could should get got go going one two".split(" "),
);
const PUNCH = new Set(
  "never always stop secret best worst every everything nothing only why mistake truth actually real biggest fastest easiest hardest must need now today free proven simple quit boring consistency discipline".split(" "),
);
const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9']/g, "").replace(/'/g, "");

/** How hard a word hits: emphasis words, numbers, length; stop words don't. */
export function wordPunch(w: string) {
  const c = clean(w);
  if (!c || STOP.has(c)) return 0;
  return (PUNCH.has(c) ? 4 : 0) + (/\d/.test(c) ? 3 : 0) + (/!$/.test(w) ? 2 : 0) + Math.min(3, c.length / 3);
}

/** The key word of a sentence (highest punch, later word wins a tie: sentences land on the end). */
export function keyWord(s: Sentence): TimedWord | null {
  let best: TimedWord | null = null;
  let score = 0;
  for (const w of s.words) {
    const p = wordPunch(w.text);
    if (p >= score && p > 0) [best, score] = [w, p];
  }
  return best;
}

export const sentencePunch = (s: Sentence) => s.words.reduce((n, w) => n + wordPunch(w.text), 0) / Math.sqrt(Math.max(1, s.words.length)) + (/!$/.test(s.words[s.words.length - 1]?.text ?? "") ? 2 : 0);

// ---------------------------------------------------------------- apply

export interface ApplyContext {
  /** Cool girl: the user's own reels (URLs), when the looks don't name them. */
  defaultOrbitSources?: string[];
}

export interface ApplyResult {
  tl: Timeline;
  needsMatte: string[]; // Cut-out clip ids with no matte yet
  notes: string[];
}

const textStyle = (o: Partial<TextStyle>): TextStyle => ({
  font: "montserrat",
  size: 120,
  color: "#FFFFFF",
  background: null,
  outline: 0,
  outlineColor: "#000000",
  shadow: 0,
  uppercase: false,
  x: 0.5,
  y: 0.5,
  ...o,
});

const fitSize = (text: string, em: number, max: number, W: number, frac = 0.88) => Math.round(Math.min(max, (W * frac) / Math.max(1, text.length * em)));

function lookTextTrack(tl: Timeline, behind: boolean): TextTrack {
  const name = behind ? LOOK_BEHIND : LOOK_TEXT;
  let t = tl.tracks.find((x): x is TextTrack => x.kind === "text" && x.role === "look" && x.name === name);
  if (t) return t;
  t = { id: uid("t"), kind: "text", name, role: "look", clips: [], ...(behind ? { behind: true } : {}) };
  if (behind) {
    // right above the "Behind me" inserts / the main video, i.e. under the Cut-out
    const i = tl.tracks.findIndex((x) => (x.role === "inserts" && x.name === BEHIND_TRACK) || isMainVideo(x));
    tl.tracks.splice(i < 0 ? tl.tracks.length : i, 0, t);
  } else {
    const i = tl.tracks.findIndex((x) => x.kind === "text");
    tl.tracks.splice(i < 0 ? 0 : i, 0, t);
  }
  return t;
}

const segAt = (segs: LookSegment[], t: number) => segs.find((s) => t >= s.start && t < s.end)?.look ?? null;

export function applyLooks(input: Timeline, ctx: ApplyContext = {}): ApplyResult {
  const notes: string[] = [];
  // mattes the previous run's cut-out copies had, to reuse (keyed by source)
  const matteCache: Matte[] = [];
  const oldCut = input.tracks.find((t) => t.role === "cutout");
  for (const c of (oldCut?.clips ?? []) as VisualClip[]) if (c.matte) matteCache.push({ ...c.matte, src: c.src } as Matte & { src?: string | null });
  for (const t of input.tracks) if (t.kind === "video") for (const c of t.clips) if (c.matte && !c.cutout) matteCache.push({ ...c.matte, src: c.src } as Matte & { src?: string | null });

  let tl = stripLooks(input);
  if (!tl.looks) {
    // a spoken cue is enough to switch looks on, even without any look settings
    const cues = detectScriptCues(tl);
    if (!cues.length) return { tl: input.looks ? tl : input, needsMatte: [], notes };
    tl.looks = { ...EMPTY_LOOKS, sections: cues };
  }
  const L = tl.looks!;
  if (L.autoScript) L.sections = [...L.sections.filter((s) => s.source !== "script"), ...detectScriptCues(tl)];
  else L.sections = L.sections.filter((s) => s.source !== "script");
  // generated content never makes the reel longer: everything stays inside the base edit
  const T0 = timelineDuration(tl);
  const segs = lookSegments(tl)
    .map((s) => ({ ...s, end: Math.min(s.end, T0) }))
    .filter((s) => s.end - s.start > 0.05);
  if (!segs.some((s) => s.look)) {
    L.applied = looksKey(tl);
    return { tl, needsMatte: [], notes };
  }

  // 1. main clips split where the look changes, so each clip has one look
  const mainIds = () => tl.tracks.filter(isMainVideo).flatMap((t) => t.clips.filter((c) => c.type !== "color").map((c) => c.id));
  for (const s of segs.slice(1)) tl = splitAt(tl, s.start, mainIds());
  const sents = sentences(tl);

  // 2. Cool dude: wide / close-up alternation at sentence boundaries (only where the source resolution allows)
  const dudeSegs = segs.filter((s) => s.look === "cool_dude");
  if (dudeSegs.length) {
    const cuts = sents.map((s) => s.start).filter((t) => dudeSegs.some((g) => t > g.start + 0.8 && t < g.end - 0.8));
    for (const t of cuts) tl = splitAt(tl, t, mainIds().filter((id) => tl.tracks.some((tr) => tr.kind === "video" && tr.clips.some((c) => c.id === id && c.start < t - 0.8 && clipEnd(c) > t + 0.8))));
  }

  // 3. grades + crops on the main clips
  let closeSkipped = 0;
  let k = 0;
  for (const tr of tl.tracks.filter(isMainVideo)) {
    for (const c of tr.clips) {
      if (c.type === "color") continue;
      const look = segAt(segs, c.start + c.duration / 2);
      if (!look) continue;
      const def = LOOKS[look];
      const orig = { grade: c.grade ?? null, transform: { ...c.transform } };
      let changed = false;
      if (def.grade) {
        c.grade = { ...def.grade };
        changed = true;
      }
      if (look === "cool_dude") {
        const close = k++ % 2 === 1;
        if (close) {
          const sw = c.srcWidth ?? 0;
          const sh = c.srcHeight ?? 0;
          const base = sw && sh ? Math.max(tl.width / sw, tl.height / sh) * c.transform.scale : 1;
          const room = Math.max(1, 1 / base); // extra zoom the source allows without upscaling
          const want = 1.3;
          const scale = L.softCloseups ? want : Math.min(want, room);
          if (scale >= 1.12) {
            c.transform = { ...c.transform, scale: c.transform.scale * scale, y: c.transform.y + 0.06 * (scale - 1) / 0.3 };
            c.lookCrop = "close";
            changed = true;
          } else closeSkipped++;
        } else c.lookCrop = "wide";
      }
      if (changed) c.lookOrig = orig;
    }
  }
  if (closeSkipped) notes.push(`Cool dude: ${closeSkipped} close-up${closeSkipped > 1 ? "s" : ""} skipped: the source is too small to crop in without upscaling (turn on soft close-ups to allow it).`);

  // 4. text: big words (Bold behind the head, Cool dude serif), one punch line per Cool girl section
  const punchWords: string[] = [];
  const W = tl.width;
  let hasBehind = false;
  for (const seg of segs) {
    if (!seg.look) continue;
    const inSeg = sents.filter((s) => s.start >= seg.start - 0.05 && s.start < seg.end);
    if (!inSeg.length) continue;
    const top = [...inSeg].sort((a, b) => sentencePunch(b) - sentencePunch(a))[0];
    if (seg.look === "bold") {
      const track = lookTextTrack(tl, true);
      hasBehind = true;
      for (const s of inSeg) {
        const w = keyWord(s);
        if (!w) continue;
        const word = w.text.replace(/[^\p{L}\p{N}'’-]/gu, "");
        const isPunch = s === top;
        if (isPunch) punchWords.push(w.id);
        const clip: TextClip = {
          ...newTextClip("headline", r3(s.start), tl.aspect, word),
          duration: r3(Math.max(0.8, Math.min(seg.end, s.end + 0.25) - s.start)),
          style: textStyle({ font: "bebas", uppercase: true, size: fitSize(word, 0.42 * 1.08, 380, W, 0.94), color: isPunch ? PUNCH_COLOR : "#FFFFFF", y: 0.27 }),
          text: word,
          animIn: "pop",
          animOut: "fade",
          gen: "look",
          role: "big",
        };
        track.clips.push(clip);
      }
    } else if (seg.look === "cool_girl") {
      const line = top.words.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
      if (line && top.words.length <= 12) {
        const track = lookTextTrack(tl, false);
        const size = fitSize(line, 0.48, 96, W, 0.82);
        const lines = line.length > 22 ? wrap(line, 22) : line;
        track.clips.push({
          ...newTextClip("headline", r3(top.start), tl.aspect, line),
          text: lines,
          duration: r3(Math.max(1.2, Math.min(seg.end, top.end + 0.4) - top.start)),
          style: textStyle({ font: "playfair-italic", size: Math.max(56, size), color: PUNCH_COLOR, y: 0.42, shadow: 3, sparkles: true }),
          animIn: "fade",
          animOut: "fade",
          gen: "look",
          role: "punch",
        });
        for (const w of top.words) if (wordPunch(w.text) > 0) punchWords.push(w.id);
      }
    } else if (seg.look === "cool_dude") {
      const track = lookTextTrack(tl, false);
      inSeg.forEach((s, i) => {
        if (i % 2 === 1 && s !== top) return; // every other sentence, and always the strongest one
        const w = keyWord(s);
        if (!w) return;
        const word = w.text.replace(/[^\p{L}\p{N}'’-]/gu, "");
        track.clips.push({
          ...newTextClip("headline", r3(s.start), tl.aspect, word),
          text: word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
          duration: r3(Math.max(0.8, Math.min(seg.end, s.end + 0.2) - s.start)),
          style: textStyle({ font: "playfair", size: fitSize(word, 0.56, 190, W, 0.86), color: "#FFFFFF", y: 0.24, shadow: 4 }),
          animIn: "fade",
          animOut: "fade",
          gen: "look",
          role: "big",
        });
      });
    }
  }
  for (const t of tl.tracks) if (t.kind === "text" && t.role === "look") t.clips.sort((a, b) => a.start - b.start);

  // 5. Cool girl: the user's reels orbiting the speaker (an insert, behind + in front)
  const girl = segs.filter((s) => s.look === "cool_girl");
  const orbit = (L.orbitSources?.length ? L.orbitSources : ctx.defaultOrbitSources ?? []).slice(0, 6);
  let hasOrbit = false;
  if (girl.length) {
    if (!orbit.length) notes.push("Cool girl: no reels of yours to orbit yet (render another project, or pick videos in the Looks panel).");
    for (const g of girl) {
      if (!orbit.length || g.end - g.start < 1.5) continue;
      const spec = makeSpec(tl, "orbit", { sources: orbit, duration: Math.min(6, g.end - g.start, T0 - g.start) });
      const ids = addInsert(tl, spec, g.start);
      for (const t of tl.tracks) if (t.kind === "video") for (const c of t.clips) if (ids.includes(c.id)) c.gen = "look";
      hasOrbit = true;
    }
  }

  // 6. the Cut-out track: the speaker on top of the behind-text / orbit (and lit on Cool dude)
  const needsMatte: string[] = [];
  const cutSegs = segs.filter((s) => s.look === "bold" || s.look === "cool_dude" || (s.look === "cool_girl" && hasOrbit));
  if (cutSegs.length) {
    const copies: VisualClip[] = [];
    for (const tr of tl.tracks.filter(isMainVideo)) {
      for (const c of tr.clips) {
        if (c.type !== "video" || !c.src) continue;
        const look = segAt(segs, c.start + c.duration / 2);
        if (!look || !cutSegs.some((s) => s.look === look && c.start < s.end && clipEnd(c) > s.start)) continue;
        const copy: VisualClip = { ...clone(c), id: uid(), muted: true, volume: 0, cutout: true, gen: "look" };
        delete copy.lookOrig;
        delete copy.lookCrop;
        const sub = LOOKS[look].subjectGrade;
        copy.grade = sub ? { ...sub } : (c.lookOrig?.grade ?? c.grade ?? null);
        // the copy only needs the matte; any background swap of the main clip is on the clip itself
        const cached = (c.matte && matteCovers(c) ? [c.matte] : []).concat(matteCache.filter((m) => (m as Matte & { src?: string }).src === c.src));
        const hit = cached.find((m) => matteCovers({ ...copy, matte: m }));
        copy.matte = hit ? { on: hit.on, url: hit.url, srcIn: hit.srcIn, srcLen: hit.srcLen, fps: hit.fps, jobId: hit.jobId ?? null } : null;
        if (!copy.matte) needsMatte.push(copy.id);
        copies.push(copy);
      }
    }
    if (copies.length) {
      const cut: VideoTrack = { id: uid("t"), kind: "video", name: CUTOUT_TRACK, role: "cutout", clips: copies.sort((a, b) => a.start - b.start) };
      // above the behind text / "Behind me" inserts / main video, under the front inserts and text
      const i = tl.tracks.findIndex((x) => (x.kind === "text" && x.behind) || (x.role === "inserts" && x.name === BEHIND_TRACK) || isMainVideo(x));
      tl.tracks.splice(i < 0 ? tl.tracks.length : i, 0, cut);
      // the front inserts (orbit's near side, CTA…) must stay above the speaker
      const ins = tl.tracks.findIndex((x) => x.role === "inserts" && x.name === INSERTS_TRACK);
      const ci = tl.tracks.indexOf(cut);
      if (ins > ci) tl.tracks.splice(ci, 0, tl.tracks.splice(ins, 1)[0]);
      if (needsMatte.length) notes.push(`Cutting the speaker out (${needsMatte.length} clip${needsMatte.length > 1 ? "s" : ""}): words behind the head and the lit speaker appear when it's done.`);
    }
  } else if (hasBehind) notes.push("Words behind the head need the speaker cut out: no video clips found under them.");

  // (splitAt returned new timeline objects: write to the current one, not the `L` read before the splits)
  tl.looks = { ...tl.looks!, punchWords: [...new Set(punchWords)], notes };
  // the key of the base this run leaves behind (incl. its splits), so the next check sees it as up to date
  tl.looks.applied = looksKey(tl);
  return { tl, needsMatte, notes };
}

function wrap(text: string, per: number) {
  const out: string[] = [];
  for (const w of text.split(/\s+/)) {
    const last = out[out.length - 1];
    if (last !== undefined && (last + " " + w).length <= per) out[out.length - 1] = last + " " + w;
    else out.push(w);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- settings changes (Looks panel, timeline lane, chat)

/** New look settings; the editor's auto-apply rebuilds the content. */
export function withLooks(tl: Timeline, patch: Partial<Looks>): Timeline {
  return { ...tl, looks: { ...EMPTY_LOOKS, ...(tl.looks ?? {}), ...patch, applied: null } };
}

/** Sections for every sentence that contains `phrase` (chat: "cool girl when I say X"). */
export function phraseSections(tl: Timeline, phrase: string, look: LookId): LookSection[] {
  const want = phrase.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (!want.length) return [];
  const out: LookSection[] = [];
  for (const s of sentences(tl)) {
    const toks = s.words.map((w) => w.text.toLowerCase().replace(/[^a-z0-9]/g, ""));
    for (let i = 0; i + want.length <= toks.length; i++) {
      if (want.every((w, j) => toks[i + j] === w)) {
        out.push({ id: uid("ls"), start: r3(s.start), end: r3(s.end + 0.2), look, source: "chat", cue: phrase });
        break;
      }
    }
  }
  return out;
}

/** Caption lines (for UI) inside a section, to label it. */
export const sectionText = (tl: Timeline, s: { start: number; end: number }) =>
  captionLines(tl)
    .filter((l) => l.start >= s.start && l.start < s.end)
    .map((l) => l.words.map((w) => w.text).join(" "))
    .join(" ")
    .slice(0, 80);
