// The taste checklist and the gotchas on disk (REEL_STUDIO_DIR). Shared by the Next.js server and the agent runner, so no
// "server-only" here. Writes are read-modify-write of one block; the files stay hand-editable.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { checklistPath, gotchasPath } from "./config";
import {
  activeChecklist,
  appendBlock,
  gotchaBlock,
  nextNumber,
  norm,
  parseGotchas,
  parseRules,
  removeBlock,
  replaceBlock,
  ruleBlock,
  type Gotcha,
  type Rule,
} from "../lib/rules/md";

const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").replace(/^﻿/, "") : "");
const write = (p: string, md: string) => writeFileSync(p, md.endsWith("\n") ? md : `${md}\n`);
export const today = () => new Date().toISOString().slice(0, 10);

const CHECKLIST_STUB = `# Taste checklist

Every ReelSmith edit is held to these rules (see the template in the ReelSmith repo: workspace/taste-checklist.md).
`;
const GOTCHAS_STUB = `# Gotchas

Every technical problem as Problem / Why it happened / Fix (see the template in the ReelSmith repo: workspace/gotchas.md).
`;

// ---------------------------------------------------------------- rules

export const readChecklist = () => read(checklistPath());
export const listRules = (): Rule[] => parseRules(readChecklist());
export const activeRules = () => listRules().filter((r) => r.status === "active");

/** Section new rules from feedback go into. */
export const FEEDBACK_SECTION = "Rules from your feedback";

export type NewRule = Pick<Rule, "title" | "words" | "inPractice" | "topic" | "type"> & { addedIn?: string | null; status?: Rule["status"] };

/** Your words are kept verbatim, in quotes (like the migrated rules). */
const quoted = (w: string) => {
  const t = w.replace(/\s+/g, " ").trim();
  return !t || /^["“].*["”]/.test(t) ? t : `"${t.replace(/"/g, "'")}"`;
};

export function addRule(r: NewRule): Rule {
  const md = readChecklist() || CHECKLIST_STUB;
  const id = `R${nextNumber(parseRules(md))}`;
  const rule: Rule = {
    id,
    n: Number(id.slice(1)),
    title: r.title,
    added: today(),
    topic: r.topic,
    type: r.type,
    status: r.status ?? "active",
    words: quoted(r.words),
    inPractice: r.inPractice,
    also: [],
    addedIn: r.addedIn ?? null,
    replacedBy: null,
    section: FEEDBACK_SECTION,
  };
  write(checklistPath(), appendBlock(md, FEEDBACK_SECTION, ruleBlock(rule)));
  return rule;
}

export function updateRule(id: string, patch: Partial<Omit<Rule, "id" | "n" | "section">>): Rule {
  const md = readChecklist();
  const cur = parseRules(md).find((r) => r.id === id);
  if (!cur) throw new Error(`${id} not found in the taste checklist`);
  const next: Rule = { ...cur, ...patch };
  write(checklistPath(), replaceBlock(md, id, ruleBlock(next)));
  return next;
}

/** Your later words that back an existing rule (kept on the rule, nothing else changes). */
export function reinforceRule(id: string, words: string, where?: string | null) {
  const cur = listRules().find((r) => r.id === id);
  if (!cur) return null;
  const line = `${today()} "${words.replace(/\s+/g, " ").trim()}"${where ? ` (${where})` : ""}`;
  if (cur.also.some((a) => a.includes(words.trim().slice(0, 60)))) return cur;
  return updateRule(id, { also: [...cur.also, line] });
}

/** Only from the Rules page, after the user confirmed (rules are never deleted without asking). */
export function deleteRule(id: string) {
  write(checklistPath(), removeBlock(readChecklist(), id));
}

/** The checklist as it goes into every headless run (disabled rules left out). */
export const checklistForPrompt = () => {
  const md = readChecklist();
  return md ? activeChecklist(md) : "(taste-checklist.md not found)";
};

// ---------------------------------------------------------------- gotchas

export const readGotchasFile = () => read(gotchasPath());
export const listGotchas = (): Gotcha[] => parseGotchas(readGotchasFile());

export type NewGotcha = Pick<Gotcha, "title" | "problem" | "why" | "fix"> & { area?: string; status?: Gotcha["status"]; key?: string | null };

/**
 * File a gotcha. The same problem again (same key, or the same title) raises its "Seen" count and keeps the newer fix
 * when one is given, instead of adding a duplicate. Section "Filed from runs" collects the automatic ones.
 */
export function addGotcha(g: NewGotcha, section = "Filed from runs"): { gotcha: Gotcha; isNew: boolean } {
  const md = readGotchasFile() || GOTCHAS_STUB;
  const list = parseGotchas(md);
  const same = list.find((x) => (g.key && x.key === g.key) || norm(x.title) === norm(g.title));
  if (same) {
    const next: Gotcha = { ...same, seen: same.seen + 1, fix: g.fix && norm(g.fix) !== norm(same.fix) ? `${same.fix}\nAgain on ${today()}: ${g.fix}` : same.fix };
    write(gotchasPath(), replaceBlock(md, same.id, gotchaBlock(next)));
    return { gotcha: next, isNew: false };
  }
  const id = `G${nextNumber(list)}`;
  const gotcha: Gotcha = {
    id,
    n: Number(id.slice(1)),
    title: g.title,
    date: today(),
    area: (g.area ?? "other").toLowerCase(),
    status: g.status ?? "fixed",
    seen: 1,
    problem: g.problem,
    why: g.why,
    fix: g.fix,
    key: g.key ?? null,
    section,
  };
  write(gotchasPath(), appendBlock(md, section, gotchaBlock(gotcha)));
  return { gotcha, isNew: true };
}
