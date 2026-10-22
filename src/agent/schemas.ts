// Schemas for the JSON files Claude writes into the project folder. The app only
// ever reads these files (never chat text); the runner validates them after each
// run and resumes the session with the errors when one doesn't match.
import { z } from "zod";

const num = z.number().finite();

// ---------------------------------------------------------------- selftest
export const mediaCheckSchema = z.object({
  files: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      kind: z.enum(["video", "audio", "image"]),
      durationSec: num.nonnegative().nullable(),
      width: z.number().int().positive().nullable(),
      height: z.number().int().positive().nullable(),
      fps: num.positive().nullable(),
      hasAudio: z.boolean(),
      orientation: z.enum(["vertical", "horizontal", "square"]).nullable(),
    }),
  ),
  summary: z.string().min(1),
});
export type MediaCheck = z.infer<typeof mediaCheckSchema>;

// ---------------------------------------------------------------- ai_edit
// Mirrors AiOp in src/lib/timeline/ai.ts; replace_visual is resolved to library media server-side.
const OP_REQUIRED = {
  cut_pauses: [],
  set_filters: ["clipIds"],
  set_clip: ["clipIds"],
  replace_visual: ["clipIds", "query"],
  add_text: ["text", "start"],
  update_text: ["clipIds"],
  delete_clips: ["clipIds"],
  set_captions: [],
  set_music: [],
  move_clip: ["clipIds", "start"],
  trim_clip: ["clipIds"],
  split: ["time"],
  remove_range: ["start", "end"],
  zoom: ["scale"], // + clipIds, or start/end
  add_fx: ["time"],
  clear_fx: [],
  set_looks: [],
} as const;
export const AI_OP_NAMES = Object.keys(OP_REQUIRED) as (keyof typeof OP_REQUIRED)[];

const aiOp = z
  .object({
    op: z.enum(AI_OP_NAMES as [keyof typeof OP_REQUIRED, ...(keyof typeof OP_REQUIRED)[]]),
    why: z.string().optional(),
    clipIds: z.array(z.string()).optional(),
    brightness: num.min(0.3).max(2).optional(),
    contrast: num.min(0.3).max(2).optional(),
    saturation: num.min(0).max(2).optional(),
    preset: z.enum(["none", "warm", "cool", "bw"]).optional(),
    speed: num.min(0.25).max(4).optional(),
    volume: num.min(0).max(2).optional(),
    muted: z.boolean().optional(),
    fadeIn: num.min(0).optional(),
    fadeOut: num.min(0).optional(),
    kenBurns: z.enum(["in", "out", "left", "right", "up", "down", "none"]).optional(),
    transition: z.enum(["cut", "crossfade", "slide", "zoom", "flash"]).optional(),
    transitionDuration: num.min(0).max(3).optional(),
    query: z.string().optional(),
    text: z.string().optional(),
    textPreset: z.enum(["title", "lower-third", "headline"]).optional(),
    color: z.string().optional(),
    size: num.positive().optional(),
    font: z.enum(["inter", "montserrat", "bebas", "playfair", "playfair-italic", "marker"]).optional(),
    x: num.optional(),
    y: num.optional(),
    animIn: z.enum(["none", "fade", "slide-up", "pop"]).optional(),
    animOut: z.enum(["none", "fade", "slide-down", "pop"]).optional(),
    enabled: z.boolean().optional(),
    captionStyle: z.enum(["bold", "karaoke", "minimal", "boxed", "kinetic", "calm", "editorial"]).optional(),
    duck: z.boolean().optional(),
    duckLevel: num.min(0).max(1).optional(),
    start: num.min(0).optional(),
    end: num.min(0).optional(),
    duration: num.positive().optional(),
    time: num.min(0).optional(),
    minGap: num.positive().optional(),
    scale: num.min(1).max(1.5).optional(),
    fx: z.enum(["punch", "shake", "flash"]).optional(),
    strength: num.min(0).max(1).optional(),
    look: z.enum(["bold", "cool_girl", "cool_dude", "none"]).optional(),
    default: z.boolean().optional(),
    phrase: z.string().max(200).optional(),
    clear: z.boolean().optional(),
  })
  .superRefine((o, ctx) => {
    for (const f of OP_REQUIRED[o.op]) {
      const v = (o as Record<string, unknown>)[f];
      if (v === undefined || (Array.isArray(v) && !v.length)) ctx.addIssue({ code: "custom", path: [f], message: `${o.op} needs ${f}` });
    }
  });

export const aiEditSchema = z.object({ summary: z.string().min(1), ops: z.array(aiOp) });
export type AiEditResult = z.infer<typeof aiEditSchema>;

// ---------------------------------------------------------------- enhance
// Mirrors Enhance in src/lib/timeline/types.ts (minus upscale, which only the user starts). Ranges are the
// safe envelope from worker/enhance.py; the analysis tool proposes well inside them.
const rgb = (lo: number, hi: number) => z.tuple([num.min(lo).max(hi), num.min(lo).max(hi), num.min(lo).max(hi)]);
export const enhanceSettingsSchema = z
  .object({
    stabilize: z.object({ on: z.boolean(), smoothing: z.number().int().min(1).max(60), maxShift: num.min(0).max(0.1), maxAngle: num.min(0).max(0.05) }).nullish(),
    denoise: z.object({ on: z.boolean(), method: z.enum(["hqdn3d", "nlmeans"]), strength: num.min(0).max(1) }).nullish(),
    sharpen: z.object({ on: z.boolean(), amount: num.min(0).max(0.8) }).nullish(),
    color: z.object({ on: z.boolean(), lo: num.min(0).max(0.2), hi: num.min(0.7).max(1), gamma: num.min(0.6).max(1.6), gains: rgb(0.85, 1.15) }).nullish(),
    match: z.object({ on: z.boolean(), gamma: num.min(0.8).max(1.25), gains: rgb(0.9, 1.1) }).nullish(),
  })
  .strict();
export const enhanceResultSchema = z.object({
  summary: z.string().min(1),
  clips: z.array(
    z.object({
      clipId: z.string(),
      settings: enhanceSettingsSchema,
      review: z.object({ ok: z.boolean(), notes: z.string() }),
    }),
  ),
});
export type EnhanceResult = z.infer<typeof enhanceResultSchema>;

// ---------------------------------------------------------------- edit modes (plan.json)
// Claude writes plan.json; the user reviews/edits it; src/server/modes.ts builds the timeline from it.
// All times are SOURCE seconds of the referenced input (sourceId = MediaAsset id), on word boundaries.
const t = num.min(0);
const captionsPlan = z.object({
  y: num.min(0.14).max(0.79), // caption centre as a fraction of the frame height: inside the safe zone, off the face
  style: z.enum(["bold", "karaoke", "minimal", "boxed"]),
  why: z.string().optional(),
});
const face = { faceX: num.min(0).max(1), faceY: num.min(0).max(1) }; // face centre, fraction of the source frame
const enhanceBySource = z.record(z.string(), enhanceSettingsSchema).optional(); // from tools/enhance.py analyze
const span = { in: t, out: t };
const checkSpan = (o: { in: number; out: number }, ctx: z.RefinementCtx) => {
  if (o.out <= o.in) ctx.addIssue({ code: "custom", path: ["out"], message: "out must be after in" });
};

export const talkingHeadPlan = z.object({
  summary: z.string().min(1),
  script: z.string(), // the cleaned script, exactly the words that stay
  sources: z.array(z.object({ id: z.string(), ...face })).min(1),
  segments: z.array(z.object({ sourceId: z.string(), ...span, text: z.string(), include: z.boolean().default(true) }).superRefine(checkSpan)).min(1),
  removed: z.array(z.object({ sourceId: z.string(), start: t, end: t, text: z.string(), reason: z.string() })),
  captions: captionsPlan,
  hook: z.object({ text: z.string().min(1), duration: num.min(1).max(6) }).nullish(),
  enhance: enhanceBySource,
});

const take = z.object({
  sourceId: z.string(),
  ...span,
  score: num.min(0).max(10),
  scores: z.object({ delivery: num, audio: num, framing: num, focus: num, lighting: num }).partial().optional(),
  note: z.string().optional(),
});
export const bestTakePlan = z.object({
  summary: z.string().min(1),
  script: z.string(),
  sources: z.array(z.object({ id: z.string(), ...face, gainDb: num.min(-12).max(12), notes: z.string().optional() })).min(1),
  lines: z.array(z.object({ text: z.string(), chosen: take, alternatives: z.array(take), why: z.string() })).min(1),
  captions: captionsPlan,
  enhance: enhanceBySource,
});

export const voiceoverPlan = z.object({
  summary: z.string().min(1),
  voiceId: z.string(),
  script: z.string(),
  broll: z.array(z.object({ id: z.string(), shows: z.string(), quality: z.string(), best: z.array(z.object({ ...span, why: z.string() })) })),
  // contiguous over the voice: start/end are VOICE seconds; sourceId = a b-roll id, or voiceId to cut back to the face
  segments: z.array(z.object({ start: t, end: t, text: z.string(), sourceId: z.string(), in: t, why: z.string() })).min(1),
  face: z.object(face).nullish(),
  captions: captionsPlan,
  music: z.object({ sourceId: z.string(), volume: num.min(0).max(1.5) }).nullish(),
  enhance: enhanceBySource,
});

export const musicPlan = z.object({
  summary: z.string().min(1),
  musicId: z.string().nullish(), // an input asset id, or
  musicFile: z.string().nullish(), // a file downloaded into the project folder (relative path, e.g. edit/music.mp3)
  musicStart: t, // second of the song the reel starts at (tell the user: it is the IG start point)
  shots: z
    .array(
      z.object({
        sourceId: z.string(),
        ...span,
        start: t, // reel time
        end: t,
        zoom: num.min(1).max(1.4).default(1),
        cx: num.min(0).max(1).default(0.5),
        cy: num.min(0).max(1).default(0.5),
        grade: z.enum(["grey", "bw", "warm"]).nullish(),
        transition: z.enum(["cut", "flash", "zoom", "slide", "crossfade"]).nullish(), // how this shot enters; null = automatic
        why: z.string(),
      }),
    )
    .min(1),
  texts: z.array(z.object({ text: z.string().min(1), start: t, end: t, y: num.min(0.14).max(0.79), accent: z.boolean().optional() })),
  // beat effects the builder adds on the music's beats (src/lib/timeline/beatfx.ts): zoom punches, drop shake/flash, transitions
  energy: z.enum(["subtle", "punchy", "hype"]).nullish(), // null/missing = punchy
  enhance: enhanceBySource,
});

export const autoClipPlan = z.object({
  summary: z.string().min(1),
  sourceId: z.string(),
  ...face,
  clips: z
    .array(z.object({ title: z.string().min(1), start: t, end: t, hook: z.string(), why: z.string(), score: num.min(0).max(10), include: z.boolean().default(true) }))
    .min(1),
  captions: captionsPlan,
});

export const PLAN_SCHEMAS = {
  talking_head: talkingHeadPlan,
  best_take: bestTakePlan,
  voiceover_broll: voiceoverPlan,
  music: musicPlan,
  auto_clip: autoClipPlan,
} as const;
export type PlanMode = keyof typeof PLAN_SCHEMAS;
export type TalkingHeadPlan = z.infer<typeof talkingHeadPlan>;
export type BestTakePlan = z.infer<typeof bestTakePlan>;
export type VoiceoverPlan = z.infer<typeof voiceoverPlan>;
export type MusicPlan = z.infer<typeof musicPlan>;
export type AutoClipPlan = z.infer<typeof autoClipPlan>;

// ---------------------------------------------------------------- chat (src/server/chat.ts)
// One chat instruction -> the workflow steps it needs. ReelSmith runs the steps as later turns of the same session.
const STAGE1_MODES = ["talking_head", "best_take", "voiceover_broll", "music", "auto_clip"] as const;
const chatAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("edit"), ops: z.array(aiOp).min(1), why: z.string().optional() }), // timeline edits, now
  z.object({ type: z.literal("cut"), brief: z.string(), mode: z.enum(STAGE1_MODES).nullish() }), // stage 1: the spoken cut
  z.object({ type: z.literal("style"), creator: z.string().nullish(), brief: z.string() }), // stage 2: style pass + stills
  z.object({ type: z.literal("stills") }),
  z.object({ type: z.literal("render"), quality: z.enum(["720p", "1080p"]).nullish() }),
  z.object({ type: z.literal("teardown"), handle: z.string().min(1), platform: z.enum(["tiktok", "youtube"]).nullish(), urls: z.array(z.string().url()).max(5).nullish() }),
  z.object({ type: z.literal("taste_rule"), rule: z.string().min(3).max(400), topic: z.string().min(1).max(40) }),
]);
export const chatResultSchema = z.object({ reply: z.string().min(1), actions: z.array(chatAction) });
export type ChatResult = z.infer<typeof chatResultSchema>;
export type ChatAction = z.infer<typeof chatAction>;

// ---------------------------------------------------------------- style pass (src/server/pipeline.ts)
export const STILL_KINDS = ["hook", "caption", "card", "transition", "zoom", "other"] as const;
export const LAYERS = ["taste", "brand", "creator", "default"] as const;
export const stylePassSchema = z.object({
  summary: z.string().min(1),
  ops: z.array(aiOp),
  // key moments to check before rendering: the hook, caption moments, visual cards, transitions
  stills: z.array(z.object({ t: t, kind: z.enum(STILL_KINDS), label: z.string().min(1).max(80), why: z.string().optional() })).min(1).max(12),
  // every place where the layers disagreed, and which one won (taste > brand > creator > default)
  conflicts: z.array(
    z.object({
      topic: z.string().min(1),
      winner: z.enum(LAYERS),
      chosen: z.string(),
      overridden: z.array(z.object({ layer: z.enum(LAYERS), value: z.string() })),
      rule: z.string().optional(), // e.g. "R14" for a taste-checklist rule
    }),
  ),
});
export type StylePass = z.infer<typeof stylePassSchema>;

// ---------------------------------------------------------------- taste rule (feedback -> reusable rule)
export const tasteRuleSchema = z.object({
  rule: z.string().min(5).max(400), // imperative, reusable: "Captions: never karaoke; one line, max 3 words."
  topic: z.string().min(1).max(40), // captions | pacing | zooms | hook | text | transitions | sound | color | layout | other
  why: z.string().optional(),
});
export type TasteRuleResult = z.infer<typeof tasteRuleSchema>;

// ---------------------------------------------------------------- notes -> rules (src/server/rules.ts, taste checklist R2/R6)
// Every job that handles the user's feedback first writes rules/<job id>.json: one entry per note, in the user's words.
// Not a job's main output (a plan / style job still validates its own file), so it is read leniently by ReelSmith.
export const NOTE_KINDS = ["rule", "reinforces", "one_off"] as const;
export const notesSchema = z.object({
  notes: z.array(
    z.object({
      words: z.string().min(1).max(2000), // the note exactly as the user said it
      kind: z.enum(NOTE_KINDS),
      rule: z
        .object({
          title: z.string().min(3).max(160),
          inPractice: z.string().min(3).max(1500),
          topic: z.string().min(1).max(40),
          type: z.enum(["taste", "default", "hard", "process"]).default("taste"),
        })
        .nullish(),
      reinforces: z.string().regex(/^R\d+$/).nullish(),
      conflictsWith: z.array(z.string().regex(/^R\d+$/)).default([]),
      conflictWhy: z.string().max(600).nullish(),
    }),
  ),
});
export type NotesResult = z.infer<typeof notesSchema>;

// ---------------------------------------------------------------- rule check (src/server/rulecheck.ts, taste checklist R5)
export const ruleCheckSchema = z.object({
  summary: z.string().min(1), // 1-3 sentences
  checked: z.number().int().min(0), // how many rules were checked
  findings: z.array(
    z.object({
      rule: z.string().regex(/^R\d+$/),
      severity: z.enum(["fail", "warn"]), // fail = breaks the rule, warn = borderline / can't be fully checked from the draft
      where: z.string().max(300), // reel time, plan entry or still number
      problem: z.string().min(1).max(800),
      fix: z.string().max(800), // what to change, at the cause, across the whole video
    }),
  ),
  passed: z.array(z.string()).default([]),
  notApplicable: z.array(z.string()).default([]),
});
export type RuleCheckReport = z.infer<typeof ruleCheckSchema>;

// ---------------------------------------------------------------- creator teardown (src/server/creators.ts)
// Claude writes style.json from worker/teardown.py's measurements + the contact sheets. Numbers come from the
// measurements; the categorical fields are Claude's reading of the sheets. ReelSmith adds "consistency" itself.
const n0 = num.nullish();
const s0 = z.string().nullish();
export const HOOK_TYPES = ["question", "bold-claim", "result-first", "pattern-interrupt", "story", "list-teaser", "demo", "other"] as const;
export const LAYOUTS = ["talking-head", "full-body", "broll-heavy", "split-screen", "green-screen", "text-on-video", "screen-recording", "mixed"] as const;
export const STRUCTURES = ["list", "timeline", "story", "tutorial", "day-in-life", "transformation", "reaction", "other"] as const;
export const CAPTION_POSITIONS = ["top", "upper-middle", "middle", "lower-middle", "bottom", "none"] as const;
export const creatorStyleSchema = z.object({
  handle: z.string().min(1),
  platform: z.enum(["tiktok", "youtube", "mixed"]),
  summary: z.string().min(1), // 2-4 sentences: what makes this creator's edits recognisable
  videos: z
    .array(
      z.object({
        id: z.string(),
        url: s0,
        title: s0,
        // Claude's reading of this video's sheets (used for the consistency check across videos)
        observed: z.object({
          // categories are compared across the videos (consistency check); the *Detail fields are free text
          hookType: z.enum(HOOK_TYPES).nullish(),
          hookDetail: s0,
          captionStyle: z.enum(["bold", "karaoke", "minimal", "boxed", "none"]).nullish(),
          captionPosition: z.enum(CAPTION_POSITIONS).nullish(),
          captionCase: z.enum(["upper", "lower", "sentence", "mixed"]).nullish(),
          zoomStyle: z.enum(["punch", "smooth", "mixed", "none"]).nullish(),
          layout: z.enum(LAYOUTS).nullish(),
          layoutDetail: s0,
          music: z.boolean().nullish(),
          structureType: z.enum(STRUCTURES).nullish(),
          structure: s0, // free text, e.g. "hook -> 3 tips -> CTA"
        }),
      }),
    )
    .min(1),
  hooks: z.object({ pattern: z.string(), textOnScreen: z.boolean().nullish(), firstWordSec: n0, examples: z.array(z.string()).default([]), notes: s0 }),
  pacing: z.object({
    avgShotSec: n0,
    medianShotSec: n0,
    cutsPerSec: n0,
    cutsFirst3s: n0,
    wordsPerMin: n0,
    pausesRemoved: z.boolean().nullish(),
    first2s: z.object({ cuts: n0, words: n0, notes: s0 }).nullish(), // what happens before the viewer can scroll away
    notes: s0,
  }),
  structure: z.object({ beats: z.array(z.string()).default([]), avgDurationSec: n0, cta: s0, notes: s0 }),
  captions: z.object({
    present: z.boolean(),
    style: z.enum(["bold", "karaoke", "minimal", "boxed"]).nullish(),
    position: z.enum(CAPTION_POSITIONS).nullish(),
    y: num.min(0).max(1).nullish(), // caption centre as a fraction of the frame height
    case: z.enum(["upper", "lower", "sentence", "mixed"]).nullish(),
    wordsPerLine: n0,
    wordsOnScreen: n0, // words visible at once
    size: z.enum(["small", "medium", "large", "huge"]).nullish(),
    sizePx: num.min(20).max(300).nullish(), // caption size in 1080x1920 design pixels
    font: s0, // closest of inter | montserrat | bebas | playfair | marker, or a description
    fontFeel: s0, // e.g. "heavy rounded sans", "condensed all-caps"
    color: s0, // #RRGGBB
    highlight: s0, // #RRGGBB of the active / emphasised word
    notes: s0,
  }),
  zooms: z.object({ perMinute: n0, style: z.enum(["punch", "smooth", "mixed", "none"]).nullish(), typicalScale: n0, onEmphasis: z.boolean().nullish(), notes: s0 }),
  sound: z.object({ music: z.boolean().nullish(), musicLevel: s0, sfx: z.array(z.string()).default([]), sfxPerMin: n0, cutsOnSoundCue: n0, notes: s0 }),
  visuals: z
    .object({ overlays: z.array(z.string()).default([]), emojis: z.boolean().nullish(), broll: z.boolean().nullish(), progressBar: z.boolean().nullish(), notes: s0 })
    .nullish(), // stickers, arrows, emoji, b-roll cutaways, screenshots, progress bars...
  layout: z.object({ framing: s0, faceY: n0, broll: z.boolean().nullish(), textCards: z.boolean().nullish(), splitScreen: z.boolean().nullish(), notes: s0 }),
  // filled in by ReelSmith after validation
  consistency: z.array(z.any()).optional(),
  consistencyVersion: z.number().optional(),
  edited: z.object({ at: z.string(), fields: z.array(z.string()) }).nullish(), // values the user changed on the Creators page
});
export type CreatorStyle = z.infer<typeof creatorStyleSchema>;

// ---------------------------------------------------------------- registry
export const SCHEMAS = {
  "media-check": mediaCheckSchema,
  "ai-edit": aiEditSchema,
  enhance: enhanceResultSchema,
  "plan-talking_head": talkingHeadPlan,
  "plan-best_take": bestTakePlan,
  "plan-voiceover_broll": voiceoverPlan,
  "plan-music": musicPlan,
  "plan-auto_clip": autoClipPlan,
  chat: chatResultSchema,
  "style-pass": stylePassSchema,
  "taste-rule": tasteRuleSchema,
  "rule-check": ruleCheckSchema,
  "creator-style": creatorStyleSchema,
} as const;
export type SchemaName = keyof typeof SCHEMAS;

/** Validate a result file's parsed JSON; returns readable error lines on failure. */
export function validateResult(name: string, data: unknown): { ok: true } | { ok: false; errors: string[] } {
  const schema = SCHEMAS[name as SchemaName];
  if (!schema) return { ok: false, errors: [`Unknown schema "${name}"`] };
  const r = schema.safeParse(data);
  if (r.success) return { ok: true };
  return { ok: false, errors: r.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
}
