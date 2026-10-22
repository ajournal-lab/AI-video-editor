// taste-checklist.md and gotchas.md (the reel-studio workspace): parse and edit them in place. Pure (no fs), so the web app,
// the agent runner and the checker prompts share one reader. The files stay hand-editable markdown: every rule is a
// "### R<n> · title" block of "- Key: value" bullets (continuation lines indented), every gotcha a "### G<n> · title" block.
// Edits replace one block and leave the rest of the file (intro, sections, your own notes) untouched.

export const RULE_TYPES = ["taste", "default", "hard", "process"] as const;
export type RuleType = (typeof RULE_TYPES)[number];
export const RULE_TOPICS = [
  "captions", "text", "hook", "pacing", "zooms", "transitions", "layout", "grade", "color", "sound", "music", "quality", "delivery", "workflow", "other",
] as const;

export interface Rule {
  id: string; // "R12"
  n: number;
  title: string;
  added: string | null;
  topic: string;
  type: RuleType;
  status: "active" | "disabled";
  words: string;
  inPractice: string;
  also: string[]; // "2026-10-22 \"...\"" lines
  addedIn: string | null;
  replacedBy: string | null;
  section: string; // the "## ..." heading above it
}

export interface Gotcha {
  id: string; // "G7"
  n: number;
  title: string;
  date: string | null;
  area: string;
  status: "fixed" | "workaround" | "open";
  seen: number;
  problem: string;
  why: string;
  fix: string;
  key: string | null; // dedupe key for automatically filed gotchas
  section: string;
}

interface Block {
  kind: "R" | "G";
  n: number;
  title: string;
  start: number; // line index of the ### heading
  end: number; // exclusive
  section: string;
  fields: [string, string][]; // in file order; meta line split into its own keys
}

const HEAD = /^###\s+([RG])(\d+)\s*[·:.\-–—]\s*(.+?)\s*$/;

function scan(md: string): { lines: string[]; blocks: Block[] } {
  const lines = md.split(/\r?\n/);
  const blocks: Block[] = [];
  let section = "";
  let fence = false;
  let cur: Block | null = null;
  const close = (i: number) => {
    if (cur) {
      // trailing blank lines don't belong to the block
      let e = i;
      while (e > cur.start + 1 && !lines[e - 1].trim()) e--;
      cur.end = e;
      blocks.push(cur);
      cur = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    if (/^##\s+/.test(l) && !/^###/.test(l)) {
      close(i);
      section = l.replace(/^##\s+/, "").trim();
      continue;
    }
    const h = HEAD.exec(l);
    if (h) {
      close(i);
      cur = { kind: h[1] as "R" | "G", n: Number(h[2]), title: h[3], start: i, end: i + 1, section, fields: [] };
      continue;
    }
    if (/^#{1,3}\s/.test(l)) {
      close(i);
      continue;
    }
    if (!cur) continue;
    const f = /^-\s+([A-Z][\w ]*?):\s?(.*)$/.exec(l);
    if (f) {
      // the meta line "Added: x · Topic: y · Type: z" carries several keys
      const parts = f[2].split(/\s+·\s+(?=[A-Z][\w ]*?:)/);
      cur.fields.push([f[1].trim(), parts[0].trim()]);
      for (const p of parts.slice(1)) {
        const m = /^([A-Z][\w ]*?):\s?(.*)$/.exec(p);
        if (m) cur.fields.push([m[1].trim(), m[2].trim()]);
      }
    } else if (/^\s{2,}\S/.test(l) && cur.fields.length) {
      const last = cur.fields[cur.fields.length - 1];
      last[1] = `${last[1]}\n${l.replace(/^\s{2}/, "")}`;
    }
  }
  close(lines.length);
  return { lines, blocks };
}

const get = (b: Block, k: string) => b.fields.find(([key]) => key.toLowerCase() === k.toLowerCase())?.[1] ?? null;
const all = (b: Block, k: string) => b.fields.filter(([key]) => key.toLowerCase() === k.toLowerCase()).map(([, v]) => v);

function toRule(b: Block): Rule {
  const type = (get(b, "Type") ?? "taste").toLowerCase();
  return {
    id: `R${b.n}`,
    n: b.n,
    title: b.title,
    added: get(b, "Added"),
    topic: (get(b, "Topic") ?? "other").toLowerCase(),
    type: (RULE_TYPES as readonly string[]).includes(type) ? (type as RuleType) : "taste",
    status: /disabled/i.test(get(b, "Status") ?? "") ? "disabled" : "active",
    words: get(b, "Your words") ?? "",
    inPractice: get(b, "In practice") ?? "",
    also: all(b, "Also said"),
    addedIn: get(b, "Added in"),
    replacedBy: get(b, "Replaced by"),
    section: b.section,
  };
}

function toGotcha(b: Block): Gotcha {
  const st = (get(b, "Status") ?? "fixed").toLowerCase();
  return {
    id: `G${b.n}`,
    n: b.n,
    title: b.title,
    date: get(b, "Date"),
    area: (get(b, "Area") ?? "other").toLowerCase(),
    status: st.startsWith("open") ? "open" : st.startsWith("work") ? "workaround" : "fixed",
    seen: Number(get(b, "Seen") ?? 1) || 1,
    problem: get(b, "Problem") ?? "",
    why: get(b, "Why it happened") ?? "",
    fix: get(b, "Fix") ?? "",
    key: get(b, "Key"),
    section: b.section,
  };
}

export const parseRules = (md: string): Rule[] => scan(md).blocks.filter((b) => b.kind === "R").map(toRule);
export const parseGotchas = (md: string): Gotcha[] => scan(md).blocks.filter((b) => b.kind === "G").map(toGotcha);

// ---------------------------------------------------------------- writing

const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, " ").trim();
/** A field whose value may span lines: continuation lines are indented 2 spaces. */
const field = (k: string, v: string) => `- ${k}: ${v.trim().split(/\r?\n/).map((l, i) => (i ? `  ${l.trimEnd()}` : l)).join("\n")}`;

export function ruleBlock(r: Omit<Rule, "n" | "section">): string {
  const out = [
    `### ${r.id} · ${oneLine(r.title)}`,
    `- Added: ${r.added ?? "unknown"} · Topic: ${r.topic} · Type: ${r.type} · Status: ${r.status}`,
    field("Your words", r.words || "not on record"),
    field("In practice", r.inPractice || "(to be written)"),
    ...r.also.map((a) => field("Also said", a)),
  ];
  if (r.addedIn) out.push(field("Added in", r.addedIn));
  if (r.replacedBy) out.push(field("Replaced by", r.replacedBy));
  return out.join("\n");
}

export function gotchaBlock(g: Omit<Gotcha, "n" | "section">): string {
  const out = [
    `### ${g.id} · ${oneLine(g.title)}`,
    `- Date: ${g.date ?? "unknown"} · Area: ${g.area} · Status: ${g.status} · Seen: ${g.seen}`,
    field("Problem", g.problem),
    field("Why it happened", g.why),
    field("Fix", g.fix),
  ];
  if (g.key) out.push(`- Key: ${g.key}`);
  return out.join("\n");
}

/** Replace the block with this id (R12 / G3); returns the new file. */
export function replaceBlock(md: string, id: string, text: string): string {
  const { lines, blocks } = scan(md);
  const b = blocks.find((x) => `${x.kind}${x.n}` === id);
  if (!b) throw new Error(`${id} not found`);
  return [...lines.slice(0, b.start), ...text.split("\n"), ...lines.slice(b.end)].join("\n");
}

export function removeBlock(md: string, id: string): string {
  const { lines, blocks } = scan(md);
  const b = blocks.find((x) => `${x.kind}${x.n}` === id);
  if (!b) throw new Error(`${id} not found`);
  let end = b.end;
  while (end < lines.length && !lines[end].trim()) end++;
  return [...lines.slice(0, b.start), ...lines.slice(end)].join("\n");
}

/** Append a block at the end of a "## section" (created at the end of the file when missing). */
export function appendBlock(md: string, section: string, text: string): string {
  const { lines } = scan(md);
  const at = lines.findIndex((l) => l.trim() === `## ${section}`);
  if (at < 0) return `${md.trimEnd()}\n\n## ${section}\n\n${text}\n`;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) if (/^##\s/.test(lines[i]) && !/^###/.test(lines[i])) { end = i; break; }
  let ins = end;
  while (ins > at + 1 && !lines[ins - 1].trim()) ins--;
  return [...lines.slice(0, ins), "", ...text.split("\n"), ...(end < lines.length ? [""] : []), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

export const nextNumber = (items: { n: number }[]) => items.reduce((m, x) => Math.max(m, x.n), 0) + 1;

/** The checklist as it goes into a headless run's instructions: the intro plus every ACTIVE rule (disabled ones left out). */
export function activeChecklist(md: string): string {
  const { lines, blocks } = scan(md);
  const drop = blocks.filter((b) => b.kind === "R" && toRule(b).status === "disabled");
  if (!drop.length) return md;
  const skip = new Set<number>();
  for (const b of drop) {
    let e = b.end;
    while (e < lines.length && !lines[e].trim()) e++;
    for (let i = b.start; i < e; i++) skip.add(i);
  }
  return lines.filter((_, i) => !skip.has(i)).join("\n");
}

/** Short one-line form for prompts and the style resolver: "R16 [pacing] Fast pacing … — in practice: …". */
export function ruleLine(r: Rule, max = 260) {
  const p = oneLine(r.inPractice);
  const s = `${r.id} [${r.topic}] ${oneLine(r.title)}${p ? ` (in practice: ${p})` : ""}`;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Loose text match for search and for "the same gotcha again". */
export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
