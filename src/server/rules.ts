import "server-only";
// The taste checklist learns from every note (taste checklist R2, R6, R7):
//   - every job that handles the user's feedback (chat turn, cut revision, stills notes, AI edit, render notes) first writes
//     rules/<job id>.json: one entry per note, in the user's words (notesBlock tells it how);
//   - absorbNotes files them in taste-checklist.md: new rules, "Also said" on a rule a note repeats, and a question in the chat
//     when a note contradicts an active rule (the job leaves that part of the note unapplied until the user picks a winner);
//   - RuleHit rows remember which projects each rule touched (the Rules page) and which rules a video added (R7).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Prisma, Project } from "@prisma/client";
import { fwd } from "@/agent/config";
import { addRule, listRules, reinforceRule, today, updateRule } from "@/agent/rulesfile";
import { notesSchema } from "@/agent/schemas";
import { RULE_TOPICS, type Rule } from "@/lib/rules/md";
import { ensureProjectDir } from "./agent";
import { prisma } from "./db";
import { HttpError } from "./http";

export type NoteSource = "chat" | "voice" | "stills" | "cut" | "render" | "ai_edit";
const SOURCE_LABEL: Record<NoteSource, string> = {
  chat: "a chat message",
  voice: "a voice note",
  stills: "notes on the key stills",
  cut: "notes on the spoken cut",
  render: "notes on a render",
  ai_edit: "an AI edit command",
};

export const notesFile = (jobId: string) => `rules/${jobId}.json`;

/** The prompt section that makes a job turn the user's notes into rules BEFORE it changes anything. */
export function notesBlock(projectDir: string, jobId: string, source: NoteSource) {
  return `
## First: the user's notes -> rules, in their words (taste checklist R2, R6). Do this BEFORE changing anything.
Write ${fwd(projectDir)}/${notesFile(jobId)} as {"notes": [ ... ]}, one entry per note in the feedback above (${SOURCE_LABEL[source]}):
{"words": "the note exactly as the user wrote or said it: verbatim, their spelling, no paraphrase",
 "kind": "rule" | "reinforces" | "one_off",
 "rule": {"title": "the lasting preference as a short imperative rule", "inPractice": "what it means for EVERY future edit, with numbers",
          "topic": "${RULE_TOPICS.join("|")}", "type": "taste"} | null,
 "reinforces": "R12" | null, "conflictsWith": ["R16"], "conflictWhy": "how they contradict" | null}
- "rule": a note about how edits should look, sound or feel (most feedback; "the captions felt busy" is a rule about captions).
  Generalise it to all future edits in "rule", but keep the user's own words in "words".
- "reinforces": an active rule in the taste checklist already says this (give its id; nothing new is added).
- "one_off": only a request to run a step ("render", "show stills") or content for this video only ("make the hook say X",
  "use clip 3"). No rule.
- A note that contradicts an ACTIVE rule: list the rule ids in "conflictsWith", and do NOT apply the contradicting part of the
  note now. ReelSmith asks the user which wins and applies it afterwards. Never edit taste-checklist.md yourself.
- No feedback at all in the message: write {"notes": []}.
Then do the change, following the new rules too. Fix the cause and check the whole video for the same problem (R4).
`;
}

// ---------------------------------------------------------------- data shown in the chat

export interface RuleNotesData {
  source: NoteSource;
  added: { id: string; title: string; words: string }[];
  reinforced: { id: string; title: string; words: string }[];
  oneOff: string[];
}
export interface RuleConflictItem {
  words: string;
  rule: { title: string; inPractice: string; topic: string; type: Rule["type"] } | null;
  conflictsWith: { id: string; title: string; words: string }[];
  why: string | null;
  choice?: "new" | "old" | "once";
  newRuleId?: string | null;
}
export interface RuleConflictData {
  jobId: string;
  source: NoteSource;
  items: RuleConflictItem[];
  resolved?: boolean;
}

async function chatNote(project: Project, text: string, data: Record<string, unknown>, jobId: string | null) {
  return prisma.chatMessage.create({
    data: { projectId: project.id, userId: project.userId, role: "assistant", text, jobId, data: data as Prisma.InputJsonValue },
  });
}

export async function hit(projectId: string, ruleId: string, kind: string, o: { note?: string | null; checkId?: string | null; jobId?: string | null } = {}) {
  await prisma.ruleHit.create({ data: { projectId, ruleId, kind, note: o.note?.slice(0, 1000) ?? null, checkId: o.checkId ?? null, jobId: o.jobId ?? null } });
}

const quote = (s: string, n = 140) => {
  const t = s.replace(/\s+/g, " ").trim();
  return `“${t.length > n ? `${t.slice(0, n - 1)}…` : t}”`;
};

/**
 * File the notes a finished (or failed) job wrote. Idempotent: a marker file next to the notes file claims it, so two
 * polls can't file the same note twice. Returns what was filed, or null when there was nothing to file.
 */
export async function absorbNotes(project: Project, jobId: string, source: NoteSource) {
  const dir = ensureProjectDir(project.id);
  const file = path.join(dir, notesFile(jobId));
  const marker = `${file}.filed`;
  if (!existsSync(file) || existsSync(marker)) return null;
  try {
    writeFileSync(marker, new Date().toISOString(), { flag: "wx" }); // exclusive create: one filer wins
  } catch {
    return null;
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    /* handled below */
  }
  const parsed = notesSchema.safeParse(raw);
  if (!parsed.success) {
    await chatNote(project, "Claude's list of your notes was invalid, so no rules were filed from it. Repeat a note if it should become a rule.", {}, jobId);
    return null;
  }
  const rules = new Map(listRules().map((r) => [r.id, r]));
  const notes: RuleNotesData = { source, added: [], reinforced: [], oneOff: [] };
  const conflicts: RuleConflictItem[] = [];
  for (const n of parsed.data.notes) {
    const against = n.conflictsWith.map((id) => rules.get(id)).filter((r): r is Rule => Boolean(r && r.status === "active"));
    if (against.length) {
      conflicts.push({
        words: n.words,
        rule: n.rule ? { title: n.rule.title, inPractice: n.rule.inPractice, topic: n.rule.topic, type: n.rule.type } : null,
        conflictsWith: against.map((r) => ({ id: r.id, title: r.title, words: r.words })),
        why: n.conflictWhy ?? null,
      });
      for (const r of against) await hit(project.id, r.id, "conflict", { note: n.words, jobId });
      continue;
    }
    if (n.kind === "reinforces" && n.reinforces && rules.get(n.reinforces)) {
      const r = reinforceRule(n.reinforces, n.words, project.title);
      if (r) {
        notes.reinforced.push({ id: r.id, title: r.title, words: n.words });
        await hit(project.id, r.id, "reinforced", { note: n.words, jobId });
      }
      continue;
    }
    if (n.kind === "rule" && n.rule) {
      const topic = (RULE_TOPICS as readonly string[]).includes(n.rule.topic) ? n.rule.topic : "other";
      const r = addRule({ title: n.rule.title, words: n.words, inPractice: n.rule.inPractice, topic, type: n.rule.type, addedIn: project.title });
      notes.added.push({ id: r.id, title: r.title, words: n.words });
      await hit(project.id, r.id, "added", { note: n.words, jobId });
      continue;
    }
    notes.oneOff.push(n.words);
  }
  if (notes.added.length || notes.reinforced.length) {
    const parts = [
      notes.added.length ? `New: ${notes.added.map((a) => `${a.id} ${quote(a.title, 80)}`).join(", ")}` : "",
      notes.reinforced.length ? `Already a rule: ${notes.reinforced.map((a) => a.id).join(", ")} (your words added to it)` : "",
    ].filter(Boolean);
    await chatNote(project, `Saved your notes in the taste checklist first, in your words. ${parts.join(". ")}.`, { ruleNotes: notes }, jobId);
  }
  if (conflicts.length) {
    await chatNote(
      project,
      conflicts.length === 1
        ? `This note contradicts ${conflicts[0].conflictsWith.map((r) => r.id).join(" and ")}, so I left that part out until you choose which wins.`
        : `${conflicts.length} notes contradict existing rules, so I left those parts out until you choose which wins.`,
      { ruleConflict: { jobId, source, items: conflicts } satisfies RuleConflictData },
      jobId,
    );
  }
  return { notes, conflicts };
}

/**
 * The user picked a winner for each contradicting note (taste checklist R6). "new" = the note becomes a rule and the old rules
 * are disabled (kept, marked "Replaced by"); "old" = the rule stays and the note is dropped; "once" = the note applies to this
 * video only. Returns the notes to apply now (new / once), which the caller sends as one follow-up chat turn.
 */
export async function resolveConflict(project: Project, messageId: string, choices: Record<number, "new" | "old" | "once">) {
  const m = await prisma.chatMessage.findFirst({ where: { id: messageId, projectId: project.id } });
  const data = (m?.data ?? null) as { ruleConflict?: RuleConflictData } | null;
  const c = data?.ruleConflict;
  if (!m || !c) throw new HttpError(404, "That question is gone");
  if (c.resolved) throw new HttpError(409, "Already answered");
  const apply: { words: string; once: boolean; keep: string[] }[] = [];
  const items: RuleConflictItem[] = [];
  for (const [i, it] of c.items.entries()) {
    const choice = choices[i];
    if (!choice) throw new HttpError(400, "Choose for every note");
    let newRuleId: string | null = null;
    if (choice === "new") {
      const rule = it.rule ?? { title: it.words.slice(0, 160), inPractice: it.words, topic: "other", type: "taste" as const };
      const r = addRule({ ...rule, words: it.words, addedIn: project.title });
      newRuleId = r.id;
      await hit(project.id, r.id, "added", { note: it.words });
      for (const old of it.conflictsWith) {
        try {
          updateRule(old.id, { status: "disabled", replacedBy: `${r.id} (${today()}, you chose the newer note: ${quote(it.words, 90)})` });
          await hit(project.id, old.id, "replaced", { note: `Replaced by ${r.id}` });
        } catch {
          /* the old rule was edited away meanwhile */
        }
      }
    } else {
      for (const old of it.conflictsWith) await hit(project.id, old.id, "conflict", { note: choice === "old" ? `Kept over: ${it.words}` : `This video only: ${it.words}` });
    }
    if (choice !== "old") apply.push({ words: it.words, once: choice === "once", keep: choice === "once" ? it.conflictsWith.map((r) => r.id) : [] });
    items.push({ ...it, choice, newRuleId });
  }
  await prisma.chatMessage.update({ where: { id: m.id }, data: { data: { ...data, ruleConflict: { ...c, items, resolved: true } } as unknown as Prisma.InputJsonValue } });
  return { apply, source: c.source };
}

/** Rules a project added (taste checklist R7: shown when a video is finished). */
export async function rulesAddedIn(projectId: string) {
  const hits = await prisma.ruleHit.findMany({ where: { projectId, kind: "added" }, orderBy: { createdAt: "asc" } });
  const byId = new Map(listRules().map((r) => [r.id, r]));
  const seen = new Set<string>();
  return hits
    .filter((h) => !seen.has(h.ruleId) && seen.add(h.ruleId))
    .map((h) => {
      const r = byId.get(h.ruleId);
      return { id: h.ruleId, title: r?.title ?? "(no longer in the checklist)", words: r?.words ?? h.note ?? "", status: r?.status ?? "deleted", addedAt: h.createdAt.toISOString() };
    });
}
