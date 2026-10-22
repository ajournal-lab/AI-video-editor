import { listRules } from "@/agent/rulesfile";
import { checklistPath } from "@/agent/config";
import { RULE_TOPICS, RULE_TYPES } from "@/lib/rules/md";
import { prisma } from "@/server/db";
import { requireUserId, route } from "@/server/http";

/**
 * The taste checklist for the Rules page: every rule (active and disabled) with the videos it affected (RuleHit rows of the
 * user's own projects: the rule was added there, repeated, broken / fixed in a draft, or a note there contradicted it).
 */
export const GET = route(async () => {
  const userId = await requireUserId();
  const rules = listRules();
  const hits = await prisma.ruleHit.findMany({
    where: { project: { userId } },
    orderBy: { createdAt: "desc" },
    take: 5000,
    include: { project: { select: { id: true, title: true, thumbnailUrl: true } } },
  });
  const byRule = new Map<string, Map<string, { id: string; title: string; thumbnailUrl: string | null; kinds: Record<string, number>; last: string; notes: string[] }>>();
  for (const h of hits) {
    const m = byRule.get(h.ruleId) ?? new Map();
    byRule.set(h.ruleId, m);
    const p = m.get(h.projectId) ?? { id: h.project.id, title: h.project.title, thumbnailUrl: h.project.thumbnailUrl, kinds: {}, last: h.createdAt.toISOString(), notes: [] };
    p.kinds[h.kind] = (p.kinds[h.kind] ?? 0) + 1;
    if (h.note && p.notes.length < 3) p.notes.push(`${h.kind}: ${h.note}`);
    m.set(h.projectId, p);
  }
  return {
    file: checklistPath(),
    topics: RULE_TOPICS,
    types: RULE_TYPES,
    rules: rules.map((r) => ({ ...r, videos: [...(byRule.get(r.id)?.values() ?? [])] })),
  };
});
