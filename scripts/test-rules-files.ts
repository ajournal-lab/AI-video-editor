// Checks the taste-checklist / gotchas reader and writer (src/lib/rules/md.ts, src/agent/rulesfile.ts) on a temporary copy
// of the workspace files: parse counts, a no-op rewrite of every block, add / edit / disable / reinforce / delete a rule,
// file a gotcha twice (dedupe -> Seen 2), and the active-only prompt text.
//   npx tsx scripts/test-rules-files.ts [<dir with taste-checklist.md and gotchas.md>]
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const src = path.resolve(process.argv[2] ?? path.join(__dirname, "..", "workspace"));
const tmp = mkdtempSync(path.join(os.tmpdir(), "rs-rules-"));
for (const f of ["taste-checklist.md", "gotchas.md"]) copyFileSync(path.join(src, f), path.join(tmp, f));
process.env.REEL_STUDIO_DIR = tmp;

async function main() {
  const md = await import("../src/lib/rules/md");
  const rf = await import("../src/agent/rulesfile");

  const before = readFileSync(path.join(tmp, "taste-checklist.md"), "utf8");
  const rules = md.parseRules(before);
  const gotchas = md.parseGotchas(readFileSync(path.join(tmp, "gotchas.md"), "utf8"));
  console.log(`rules: ${rules.length} (${rules.filter((r) => r.status === "active").length} active), gotchas: ${gotchas.length}`);
  assert.ok(rules.length >= 50 && gotchas.length >= 40, "the template blocks inside ``` fences must not be counted");
  assert.deepEqual(rules.map((r) => r.n), [...rules.map((r) => r.n)].sort((a, b) => a - b), "rule numbers in order");
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length, "no duplicate rule ids");
  for (const r of rules) {
    assert.ok(r.title && r.added && r.inPractice, `${r.id} has a title, date and In practice`);
    assert.ok((md.RULE_TYPES as readonly string[]).includes(r.type), `${r.id} type`);
    assert.ok((md.RULE_TOPICS as readonly string[]).includes(r.topic), `${r.id} topic ${r.topic}`);
  }
  for (const g of gotchas) assert.ok(g.problem && g.why && g.fix, `${g.id} has Problem / Why / Fix`);
  const r36 = rules.find((r) => r.id === "R36")!;
  assert.ok(r36.inPractice.includes("Self-check (must pass)"), "multi-line In practice keeps its sub-bullets");

  // rewriting every block from its parsed form keeps the parse identical
  let again = before;
  for (const r of rules) again = md.replaceBlock(again, r.id, md.ruleBlock(r));
  assert.deepEqual(md.parseRules(again), rules, "round trip");

  // add / edit / reinforce / disable / delete
  const added = rf.addRule({ title: "Max 3 words of captions on screen", words: "The captions felt busy, too many words at once.", inPractice: "Captions show at most 3 words.", topic: "captions", type: "taste", addedIn: "Test project" });
  assert.equal(added.id, `R${rules.length + 1}`);
  assert.ok(rf.readChecklist().includes("## Rules from your feedback"));
  rf.reinforceRule(added.id, "still too many words", "Test 2");
  rf.updateRule(added.id, { status: "disabled", replacedBy: "R999 (test)" });
  const back = rf.listRules().find((r) => r.id === added.id)!;
  assert.equal(back.status, "disabled");
  assert.equal(back.also.length, 1);
  assert.equal(back.words, '"The captions felt busy, too many words at once."');
  assert.ok(!rf.checklistForPrompt().includes(`### ${added.id} ·`), "disabled rules are left out of the prompt");
  assert.ok(rf.checklistForPrompt().includes("### R1 ·"));
  rf.deleteRule(added.id);
  assert.equal(rf.listRules().length, rules.length);

  // gotchas: the same problem twice raises Seen
  const a = rf.addGotcha({ title: "plan.json failed validation (texts.*.accent)", problem: "x", why: "y", fix: "resumed", area: "agent", key: "schema:plan-music:texts.*.accent" });
  const b = rf.addGotcha({ title: "different words, same key", problem: "x", why: "y", fix: "resumed", area: "agent", key: "schema:plan-music:texts.*.accent" });
  assert.ok(a.isNew && !b.isNew && b.gotcha.seen === 2 && a.gotcha.id === b.gotcha.id);
  console.log("all checks passed in", tmp);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
