// Timestamped corrections in a chat message: every line like
//   "Around 0:18, cut the breath"  "at 1:02 - bigger zoom"  "0:05–0:07: remove this"  "~12s punchier"
// becomes one fix. All fixes of one message are applied as ONE rebuild (one plan revision or one set of ops).
// Times are reel times (the cut / timeline the user is looking at).

export interface Fix {
  at: number; // seconds
  end: number | null; // a range "0:05-0:07"
  label: string; // as typed, e.g. "0:18"
  text: string;
}

const TIME = String.raw`(\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?\s*s(?:ec)?\b)`;
const LINE = new RegExp(
  String.raw`^\s*(?:[-*•]\s*|\d+[.)]\s+)?((?:around|at|about|near|approx\.?|~|@)\s*)?` + TIME + String.raw`(?:\s*(?:-|–|—|to)\s*` + TIME + String.raw`)?\s*([,:;)\-–—]\s*|\s+)(.+)$`,
  "i",
);

export function parseTime(s: string): number {
  const t = s.trim().toLowerCase().replace(/\s*s(?:ec)?$/, "");
  if (t.includes(":")) {
    const [m, sec] = t.split(":");
    return Number(m) * 60 + Number(sec);
  }
  return Number(t);
}

export const fmtTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0").replace(/\.0$/, "")}`;

/** Split a message into timestamped fixes and the rest of the text. */
export function parseFixes(text: string): { fixes: Fix[]; rest: string } {
  const fixes: Fix[] = [];
  const rest: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    // "30s reel, punchy" is a length, not a timestamp: bare "Ns" needs a prefix (around/at/~) or a separator
    const [, prefix, t1, t2, sep, body] = m ?? [];
    const explicit = Boolean(prefix) || Boolean(sep?.trim()) || Boolean(t1?.includes(":"));
    if (m && body?.trim() && explicit) {
      const at = parseTime(t1);
      const end = t2 ? parseTime(t2) : null;
      if (Number.isFinite(at)) {
        fixes.push({ at, end: end !== null && Number.isFinite(end) && end > at ? end : null, label: t2 ? `${t1}–${t2}` : t1, text: body.trim() });
        continue;
      }
    }
    rest.push(line);
  }
  return { fixes: fixes.sort((a, b) => a.at - b.at), rest: rest.join("\n").trim() };
}

/** Fixes as a prompt block, optionally with what is on screen / said at each time. */
export function fixesBlock(fixes: Fix[], context?: (f: Fix) => string) {
  return fixes
    .map((f, i) => `${i + 1}. at ${f.end !== null ? `${f.at.toFixed(2)}-${f.end.toFixed(2)}` : f.at.toFixed(2)} s (typed "${f.label}"): ${f.text}${context ? `\n   ${context(f)}` : ""}`)
    .join("\n");
}
