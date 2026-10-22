import { z } from "zod";
import { deleteRule, listRules, updateRule } from "@/agent/rulesfile";
import { RULE_TOPICS, RULE_TYPES } from "@/lib/rules/md";
import { prisma } from "@/server/db";
import { HttpError, requireUserId, route, type Ctx } from "@/server/http";

const patch = z.object({
  title: z.string().trim().min(3).max(160).optional(),
  words: z.string().trim().max(2000).optional(),
  inPractice: z.string().trim().min(3).max(3000).optional(),
  topic: z.enum(RULE_TOPICS).optional(),
  type: z.enum(RULE_TYPES).optional(),
  status: z.enum(["active", "disabled"]).optional(),
});

/** Edit a rule in taste-checklist.md (the Rules page), or disable / enable it. */
export const PATCH = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  await requireUserId();
  const { id } = await ctx.params;
  const parsed = patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid change");
  if (!listRules().some((r) => r.id === id)) throw new HttpError(404, `${id} is not in the taste checklist`);
  const p = parsed.data;
  // re-enabling a replaced rule clears the "Replaced by" note
  return { rule: updateRule(id, { ...p, ...(p.status === "active" ? { replacedBy: null } : {}) }) };
});

/**
 * Delete a rule. Rules are never deleted without asking (taste checklist R6): the page asks first and sends confirm=yes.
 * Disabling keeps the rule for history and is usually the better choice.
 */
export const DELETE = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  if (new URL(req.url).searchParams.get("confirm") !== "yes") throw new HttpError(400, "Confirm the delete first");
  if (!listRules().some((r) => r.id === id)) throw new HttpError(404, `${id} is not in the taste checklist`);
  deleteRule(id);
  await prisma.ruleHit.deleteMany({ where: { ruleId: id, project: { userId } } });
  return { ok: true };
});
