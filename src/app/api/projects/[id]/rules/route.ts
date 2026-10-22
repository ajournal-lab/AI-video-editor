import { z } from "zod";
import { postChat } from "@/server/chat";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";
import { resolveConflict, rulesAddedIn } from "@/server/rules";

/** The rules this project added to the taste checklist (R7: shown when the video is finished). */
export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  return { added: await rulesAddedIn(id) };
});

const body = z.object({ messageId: z.string(), choices: z.record(z.string(), z.enum(["new", "old", "once"])), json: z.any().optional() });

/**
 * Answer "which wins?" for notes that contradicted a rule (R6). The notes the user let win (or kept for this video only) are
 * then applied in one chat turn, without being filed again.
 */
export const POST = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const project = await ownedProject(id, userId);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Invalid answer");
  const choices = Object.fromEntries(Object.entries(parsed.data.choices).map(([k, v]) => [Number(k), v]));
  const { apply } = await resolveConflict(project, parsed.data.messageId, choices);
  if (!apply.length) return { applied: false };
  const text = [
    "Apply these notes now (I already chose which rule wins; they are filed, don't file them again):",
    ...apply.map((a) => `- "${a.words}"${a.once ? ` (for this video only: keep ${a.keep.join(", ")} for future edits)` : ""}`),
  ].join("\n");
  const res = await postChat({ project, text, timeline: parsed.data.json, noNotes: true });
  return { applied: true, ...res };
});
