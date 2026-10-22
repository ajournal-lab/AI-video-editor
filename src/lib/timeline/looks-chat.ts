// Look switches in plain words, without a Claude turn: "cool girl when I say boring, bold everywhere else",
// "make it cool dude", "cool girl from 0:05 to 0:09", "no looks". Returns set_looks edit ops (also what Claude may
// emit) or null when the message isn't only about looks.
import type { AiOp } from "./ai";
import { parseLookName } from "./lookdefs";
import type { LookId } from "./types";

const LOOK_RE = /\b(bold|cool[\s-]?girl|that[\s-]?girl|cool[\s-]?dude|cool[\s-]?guy|editorial)(?:\s+(?:aesthetic|look|style|vibe|mode))?\b/i;
const TIME = String.raw`(\d{1,2}:\d{2}(?:\.\d+)?|\d+(?:\.\d+)?)\s*s?`;
const RANGE = new RegExp(String.raw`(?:from\s+|between\s+|at\s+)?${TIME}\s*(?:-|–|—|to|and|until)\s*${TIME}`, "i");

const toSec = (s: string) => (s.includes(":") ? Number(s.split(":")[0]) * 60 + Number(s.split(":")[1]) : Number(s));

export function parseLookCommand(text: string): { ops: AiOp[]; summary: string } | null {
  const t = text.trim();
  if (/\b(no|remove|clear|turn off|switch off|without)\b.*\blooks?\b/i.test(t) && !LOOK_RE.test(t)) return { ops: [{ op: "set_looks", clear: true }], summary: "Looks off" };
  if (!LOOK_RE.test(t)) return null;
  const clauses = splitClauses(t);
  const ops: AiOp[] = [];
  const parts: string[] = [];
  let pendingLook: LookId | null = null;
  for (const c of clauses) {
    const m = LOOK_RE.exec(c);
    const look: LookId | null = m ? parseLookName(m[1]) : pendingLook;
    if (!look) continue;
    const said = /\b(?:when(?:ever)?\s+i\s+(?:say|talk about|mention)|on the (?:line|words?)|for the (?:line|part)|during)\s+["“']?(.+?)["”']?$/i.exec(c);
    const range = RANGE.exec(c);
    const def = /\b(everywhere(?: else)?|the rest|rest of (?:it|the (?:video|reel))|by default|default|everything else|overall|whole (?:video|reel|thing))\b/i.test(c);
    if (said) {
      const phrase = said[1].replace(/\s+(?:look|aesthetic|style)$/i, "").trim();
      if (!phrase) continue;
      ops.push({ op: "set_looks", look, phrase });
      parts.push(`${label(look)} when you say “${phrase}”`);
    } else if (range) {
      const a = toSec(range[1]);
      const b = toSec(range[2]);
      if (!(b > a)) continue;
      ops.push({ op: "set_looks", look, start: a, end: b });
      parts.push(`${label(look)} ${range[1]}–${range[2]}`);
    } else if (def || clauses.length === 1 || /\b(make it|use|go|switch to|apply|set)\b/i.test(c)) {
      ops.push({ op: "set_looks", look, default: true });
      parts.push(`${label(look)} everywhere else`);
    } else {
      pendingLook = look; // "cool girl, when I say X" split across clauses
      continue;
    }
    pendingLook = null;
  }
  if (!ops.length) return null;
  // the default goes first so a phrase section applied after it stays on top
  ops.sort((a, b) => Number(Boolean(b.default)) - Number(Boolean(a.default)));
  return { ops, summary: `Looks: ${parts.join(", ")}` };
}

/** Clauses: commas, semicolons, sentence ends, "and"/"then"/"but", except inside "7 and 10" / "0:03.5". */
function splitClauses(t: string) {
  return t
    .split(/[,;]|\.(?!\d)\s*|\b(?:and|then|but)\b(?!\s*\d)/i)
    .map((c) => c.trim())
    .filter(Boolean);
}

const label = (id: LookId) => ({ bold: "Bold", cool_girl: "Cool girl", cool_dude: "Cool dude" })[id];

/** True when every clause of a message is about looks (so no Claude turn is needed). */
export function isOnlyLookCommand(text: string) {
  if (/\b(no|remove|clear|turn off|switch off)\b.*\blooks?\b/i.test(text) && !LOOK_RE.test(text)) return splitClauses(text).length <= 2;
  const filler = /^(?:please|thanks|thank you|ok|okay)$/i;
  const rest = /^(?:for\s+)?(?:everywhere(?: else)?|the rest(?: of (?:it|the (?:video|reel)))?|by default|everything else|overall)$/i;
  return splitClauses(text).every((c) => LOOK_RE.test(c) || filler.test(c) || rest.test(c));
}
