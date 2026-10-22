import { z } from "zod";
import { HttpError, requireUserId, route } from "@/server/http";
import { appendTasteRule, tasteRules } from "@/server/style";
import { TASTE_TOPICS } from "@/lib/style/layers";

/** The taste rules in rules.md (they override creator style and the brand kit). */
export const GET = route(async () => {
  await requireUserId();
  return { rules: tasteRules(), topics: TASTE_TOPICS };
});

const body = z.object({ rule: z.string().trim().min(5).max(400), topic: z.enum(TASTE_TOPICS) });

/** Save a taste rule (after the user confirmed the wording). */
export const POST = route(async (req: Request) => {
  await requireUserId();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid rule");
  return { rule: appendTasteRule(parsed.data.rule, parsed.data.topic) };
});
