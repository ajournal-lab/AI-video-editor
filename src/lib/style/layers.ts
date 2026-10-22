// Style priority (taste checklist R44): the user's taste rules > the client's brand kit > the creator's
// style.json > ReelSmith defaults. resolveStyle() picks the winning value per topic and lists every conflict, so the
// UI can show which rule won. Pure (no fs): the server passes in what it read.
import type { BrandKit } from "@/agent/settings";
import { RULE_TOPICS } from "@/lib/rules/md";

export type Layer = "taste" | "brand" | "creator" | "default";
export const LAYER_LABEL: Record<Layer, string> = { taste: "Your taste rule", brand: "Brand kit", creator: "Creator style", default: "Default" };

/** An active "Type: taste" rule of the taste checklist, as the resolver and the prompts use it. */
export interface TasteRule {
  id: string; // "R14"
  date: string | null;
  topic: string; // one of RULE_TOPICS
  text: string;
}

/** The parts of a creator's style.json the resolver compares (all optional: teardowns can be partial). */
export interface CreatorStyleLite {
  handle?: string;
  captions?: { style?: string | null; case?: string | null; font?: string | null; color?: string | null; highlight?: string | null; position?: string | null; wordsPerLine?: number | null } | null;
  pacing?: { avgShotSec?: number | null; wordsPerMin?: number | null } | null;
  zooms?: { perMinute?: number | null; style?: string | null; typicalScale?: number | null } | null;
  hooks?: { pattern?: string | null; textOnScreen?: boolean | null } | null;
  sound?: { music?: boolean | null; sfx?: string[] | null } | null;
  layout?: { framing?: string | null } | null;
}

/** Topics the layers can set, with the taste-rule topic that overrides each. */
const TOPICS: { key: string; label: string; taste: string; brand?: (b: BrandKit) => unknown; creator?: (c: CreatorStyleLite) => unknown; def: unknown }[] = [
  { key: "captions.style", label: "Caption style", taste: "captions", brand: (b) => b.captionStyle, creator: (c) => c.captions?.style, def: "bold" },
  { key: "captions.case", label: "Caption case", taste: "captions", brand: (b) => (b.uppercase == null ? null : b.uppercase ? "upper" : "as spoken"), creator: (c) => c.captions?.case, def: "as spoken" },
  { key: "captions.font", label: "Font", taste: "text", brand: (b) => b.font, creator: (c) => c.captions?.font, def: "montserrat" },
  { key: "captions.color", label: "Text colour", taste: "color", brand: (b) => b.primary, creator: (c) => c.captions?.color, def: "#FFFFFF" },
  { key: "captions.highlight", label: "Highlight colour", taste: "color", brand: (b) => b.accent, creator: (c) => c.captions?.highlight, def: "#FFD60A" },
  { key: "captions.position", label: "Caption position", taste: "captions", creator: (c) => c.captions?.position, def: "lower third, inside the safe zone" },
  { key: "pacing.avgShotSec", label: "Average shot length", taste: "pacing", creator: (c) => c.pacing?.avgShotSec, def: "1-3 s (talking head: cut pauses > 0.3 s)" },
  { key: "zooms.perMinute", label: "Zooms per minute", taste: "zooms", creator: (c) => c.zooms?.perMinute, def: "alternate 100/110% on jump cuts" },
  { key: "zooms.style", label: "Zoom style", taste: "zooms", creator: (c) => c.zooms?.style, def: "punch" },
  { key: "hook.pattern", label: "Hook", taste: "hook", creator: (c) => c.hooks?.pattern, def: "2-6 word on-screen hook in the first 2-3 s" },
  { key: "sound.sfx", label: "Sound effects", taste: "sound", creator: (c) => (c.sound?.sfx?.length ? c.sound.sfx.join(", ") : null), def: "none" },
];

export interface ResolvedTopic {
  key: string;
  label: string;
  winner: Layer;
  value: string;
  rule?: string; // taste rule id
  overridden: { layer: Layer; value: string }[];
}

const show = (v: unknown) => (typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v));
const has = (v: unknown) => v !== null && v !== undefined && v !== "";

export function resolveStyle(input: { taste: TasteRule[]; brand: BrandKit | null; creator: CreatorStyleLite | null }) {
  const brand = input.brand?.enabled ? input.brand : null;
  const topics: ResolvedTopic[] = [];
  for (const t of TOPICS) {
    const layers: { layer: Layer; value: string; rule?: string }[] = [];
    const rules = input.taste.filter((r) => r.topic === t.taste);
    if (rules.length) layers.push({ layer: "taste", value: rules.map((r) => `${r.id}: ${r.text}`).join(" / "), rule: rules.map((r) => r.id).join(", ") });
    const b = brand && t.brand ? t.brand(brand) : null;
    if (has(b)) layers.push({ layer: "brand", value: show(b) });
    const c = input.creator && t.creator ? t.creator(input.creator) : null;
    if (has(c)) layers.push({ layer: "creator", value: show(c) });
    layers.push({ layer: "default", value: show(t.def) });
    const [win, ...rest] = layers;
    topics.push({ key: t.key, label: t.label, winner: win.layer, value: win.value, rule: win.rule, overridden: rest.map(({ layer, value }) => ({ layer, value })) });
  }
  // a conflict = a higher layer overrode a value some lower, non-default layer set
  const conflicts = topics.filter((t) => t.overridden.some((o) => o.layer !== "default" && o.value !== t.value));
  return { topics, conflicts };
}

export const TASTE_TOPICS = RULE_TOPICS;
