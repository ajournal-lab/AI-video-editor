import "server-only";
// Taste checklist R5: before a draft is shown, a FRESH Claude session (a new session id: it has not seen the edit being made)
// checks it against every active rule. Drafts: the spoken cut (stage 1, plan.json) and the key stills (stage 2). The
// failures go back to the project's own session to fix (at the cause, across the whole video: R4), then the draft is shown
// with "checked N rules: found …, fixed …, left …" in the chat. A check that can't run never blocks the draft.
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Prisma, Project, RuleCheck } from "@prisma/client";
import { fwd } from "@/agent/config";
import { activeRules, listRules } from "@/agent/rulesfile";
import { ruleCheckSchema, type RuleCheckReport } from "@/agent/schemas";
import { describeForAi } from "@/lib/timeline/ai";
import type { Timeline } from "@/lib/timeline/types";
import { createJob, ensureProjectDir, localMediaPath } from "./agent";
import { prisma } from "./db";
import { hit } from "./rules";

export type CheckTarget = "cut" | "stills";

const reportFile = (id: string) => `checks/${id}.json`;
export const fixedFile = (id: string) => `checks/${id}.fixed.json`;

async function inputsList(project: Project) {
  const inputs = (project.inputs ?? null) as { assets?: Record<string, string[]> } | null;
  const ids = Object.values(inputs?.assets ?? {}).flat();
  if (!ids.length) return "";
  const assets = await prisma.mediaAsset.findMany({ where: { userId: project.userId, id: { in: ids } } });
  return assets.map((a) => `- ${a.id} | ${a.type} | ${fwd(localMediaPath(a.url) ?? "(not local)")} | ${a.duration?.toFixed(1) ?? "?"}s | "${a.name}"`).join("\n");
}

function checkerPrompt(o: { project: Project; target: CheckTarget; file: string; materials: string; dir: string }) {
  const rules = activeRules();
  const checkable = rules.filter((r) => r.type !== "process").map((r) => r.id);
  return `## Rule check: an independent review of a draft (taste checklist R5)
You did NOT make this edit and you can't change it: you only check it, like a picky editor who has never seen it. Check this draft of
"${o.project.title}" (${o.project.mode}, ${o.project.aspect}) against EVERY active rule in the taste checklist in your instructions:
${checkable.join(", ")}. Process rules (${rules.filter((r) => r.type === "process").map((r) => r.id).join(", ") || "none"}) are about how the work is done: list them under "notApplicable".

## The draft
${o.materials}
Project folder: ${o.dir}

## How to check
- Go rule by rule. A rule that can't apply to this draft (e.g. music rules when there is no music, caption rules on a cut that has
  no captions yet) goes under "notApplicable". Everything else is "passed" or a finding.
- Look at the real media wherever a rule is visual (text over the face, safe zones, framing, grain, cut points): the images listed
  above, or contact_sheet.py / timeline_view.py on the sources. Use the numbers (times, sizes, loudness) wherever a rule has one.
- A finding: {"rule": "R17", "severity": "fail" (it breaks the rule) | "warn" (borderline, or can't be fully checked from this draft),
  "where": "reel 0:04-0:06 / segments[3] / still 2", "problem": "what is wrong, specifically", "fix": "what to change AT THE CAUSE
  so it is fixed everywhere in the video (R4), not just at this moment"}. Same problem in several places = one finding listing them.
- Don't invent problems: a pass is a pass. Don't re-check the gotchas; they are for the editor.

## Write ${o.file}
{"summary": "1-3 sentences", "checked": <number of rules you checked>, "findings": [...], "passed": ["R9", ...], "notApplicable": ["R1", ...]}
Write only that file.`;
}

/** Start a fresh check of a draft. The check job's id is also the RuleCheck id. */
export async function startCheck(project: Project, target: CheckTarget, subjectJobId: string, o: { timeline?: Timeline | null; stills?: { t: number; label: string; file: string | null }[] } = {}) {
  const dir = ensureProjectDir(project.id);
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const inputs = await inputsList(project);
  let materials = "";
  if (target === "cut") {
    materials = `Stage 1, the SPOKEN CUT, waiting for the user's review: ${fwd(dir)}/plan.json (the plan: segments / lines / shots with source
in-out seconds and what is said; times are source seconds). Transcript with word timings: ${fwd(dir)}/edit/transcript.json (if present).
There is no styling yet: captions, zooms, text cards, looks and grade come in stage 2, so rules about those are "notApplicable" unless
plan.json already sets them (e.g. a hook text, a caption y, a grade, energy, texts).
${inputs ? `Inputs (asset id | type | file | duration | name):\n${inputs}` : ""}`;
  } else {
    const tlFile = path.join(dir, "checks", `${id}.timeline.json`);
    if (o.timeline) writeFileSync(tlFile, JSON.stringify(describeForAi(o.timeline), null, 1));
    materials = `Stage 2, the STYLED EDIT, shown to the user as key stills before rendering.
Timeline (clip ids, times, what is said, captions, text, fx, transitions, maxZoom per clip): ${fwd(tlFile)}
Key stills, rendered by the export engine from exactly this timeline (Read each image):
${(o.stills ?? []).map((s, i) => `${i + 1}. t=${s.t}s ${s.label}: ${s.file ? `${fwd(dir)}/${s.file}` : "(missing)"}`).join("\n")}
${inputs ? `Sources (asset id | type | file | duration | name):\n${inputs}` : ""}`;
  }
  const job = await createJob({
    id,
    userId: project.userId,
    projectId: project.id,
    kind: "rule_check",
    title: `Rule check · ${target === "cut" ? "the spoken cut" : "the key stills"}`,
    prompt: checkerPrompt({ project, target, file: `${fwd(dir)}/${reportFile(id)}`, materials, dir: fwd(dir) }),
    resumeSessionId: null, // a fresh session on purpose
    outputFile: reportFile(id),
    schema: "rule-check",
    timeoutSec: 25 * 60,
  });
  return prisma.ruleCheck.create({ data: { id: job.id, projectId: project.id, target, subjectJobId, jobId: job.id, status: "checking" } });
}

export function readReport(projectId: string, id: string): RuleCheckReport | null {
  const f = path.join(ensureProjectDir(projectId), reportFile(id));
  if (!existsSync(f)) return null;
  try {
    const r = ruleCheckSchema.safeParse(JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function readFixed(projectId: string, id: string): { rule: string; what: string }[] {
  const f = path.join(ensureProjectDir(projectId), fixedFile(id));
  if (!existsSync(f)) return [];
  try {
    const j = JSON.parse(readFileSync(f, "utf8").replace(/^﻿/, "")) as { fixed?: { rule?: string; what?: string }[] };
    return (j.fixed ?? []).filter((x) => x.rule && x.what).map((x) => ({ rule: String(x.rule), what: String(x.what) }));
  } catch {
    return [];
  }
}

/** The check job finished: store its report and the findings per rule. Returns the findings the editor should fix. */
export async function takeReport(project: Project, rc: RuleCheck) {
  const job = await prisma.agentJob.findUnique({ where: { id: rc.jobId } });
  if (!job || job.status === "queued" || job.status === "running") return { state: "running" as const };
  const report = job.status === "done" ? readReport(project.id, rc.id) : null;
  if (!report) {
    const note = job.status === "done" ? "The checker's report was missing or invalid" : (job.error ?? `The check ${job.status}`);
    await prisma.ruleCheck.update({ where: { id: rc.id }, data: { status: "failed", note, finishedAt: new Date() } });
    return { state: "failed" as const, note };
  }
  for (const f of report.findings) await hit(project.id, f.rule, f.severity === "fail" ? "violated" : "warned", { note: `${f.where}: ${f.problem}`, checkId: rc.id });
  await prisma.ruleCheck.update({ where: { id: rc.id }, data: { report: report as unknown as Prisma.InputJsonValue } });
  return { state: "done" as const, report, toFix: report.findings };
}

/** What the editing session is asked to fix (in the plan revision or the style revision). */
export function fixBrief(rcId: string, report: RuleCheckReport, dir: string) {
  return `A fresh checker reviewed this draft against the taste checklist and found:
${report.findings.map((f) => `- ${f.rule} (${f.severity}) at ${f.where}: ${f.problem}${f.fix ? ` -> ${f.fix}` : ""}`).join("\n")}
Fix every "fail" at its cause, then check the whole video for the same problem and fix it there too (R4). Fix a "warn" when you can do
it without breaking another rule. Don't change anything else.
Also write ${fwd(dir)}/${fixedFile(rcId)} as {"fixed": [{"rule": "R17", "what": "what you changed, and in how many places"}], "notFixed": [{"rule": "R13", "why": "..."}]}.`;
}

/** Close the check after the fix (or with nothing to fix) and post the result in the chat. */
export async function finishCheck(project: Project, rcId: string, o: { fixFailed?: string | null } = {}) {
  const rc = await prisma.ruleCheck.findUnique({ where: { id: rcId } });
  if (!rc || rc.status === "done" || rc.status === "failed") return rc;
  const fixed = rc.fixJobId && !o.fixFailed ? readFixed(project.id, rc.id) : [];
  for (const f of fixed) await hit(project.id, f.rule, "fixed", { note: f.what, checkId: rc.id });
  const done = await prisma.ruleCheck.update({
    where: { id: rc.id },
    data: { status: "done", fixed: fixed as unknown as Prisma.InputJsonValue, note: o.fixFailed ?? null, finishedAt: new Date() },
  });
  await postCheckMessage(project, done);
  return done;
}

export async function failCheck(project: Project, rcId: string, note: string) {
  const rc = await prisma.ruleCheck.update({ where: { id: rcId }, data: { status: "failed", note, finishedAt: new Date() } });
  await postCheckMessage(project, rc);
  return rc;
}

export interface CheckSummary {
  id: string;
  target: CheckTarget;
  status: string;
  checked: number;
  summary: string;
  found: { rule: string; title: string; severity: "fail" | "warn"; where: string; problem: string }[];
  fixed: { rule: string; title: string; what: string }[];
  left: { rule: string; title: string; problem: string }[];
  note: string | null;
}

export function summarize(rc: RuleCheck): CheckSummary {
  const titles = new Map(listRules().map((r) => [r.id, r.title]));
  const report = (rc.report ?? null) as RuleCheckReport | null;
  const fixed = ((rc.fixed ?? []) as { rule: string; what: string }[]).map((f) => ({ ...f, title: titles.get(f.rule) ?? "" }));
  const fixedIds = new Set(fixed.map((f) => f.rule));
  const found = (report?.findings ?? []).map((f) => ({ rule: f.rule, title: titles.get(f.rule) ?? "", severity: f.severity, where: f.where, problem: f.problem }));
  return {
    id: rc.id,
    target: rc.target as CheckTarget,
    status: rc.status,
    checked: report?.checked ?? 0,
    summary: report?.summary ?? "",
    found,
    fixed,
    left: found.filter((f) => !fixedIds.has(f.rule)).map((f) => ({ rule: f.rule, title: f.title, problem: f.problem })),
    note: rc.note,
  };
}

async function postCheckMessage(project: Project, rc: RuleCheck) {
  const s = summarize(rc);
  const what = rc.target === "cut" ? "the spoken cut" : "the key stills";
  const text =
    rc.status === "failed"
      ? `The rule check on ${what} couldn't run (${s.note ?? "unknown error"}), so it is shown unchecked.`
      : !s.found.length
        ? `A fresh checker checked ${what} against ${s.checked} rules: nothing broke a rule.`
        : `A fresh checker checked ${what} against ${s.checked} rules: found ${s.found.length} problem${s.found.length > 1 ? "s" : ""}, fixed ${s.fixed.length}${s.left.length ? `, ${s.left.length} left for you to look at` : ""}.${s.note ? ` (${s.note})` : ""}`;
  await prisma.chatMessage.create({
    data: { projectId: project.id, userId: project.userId, role: "assistant", text, jobId: rc.jobId, data: { ruleCheck: s } as unknown as Prisma.InputJsonValue },
  });
}
