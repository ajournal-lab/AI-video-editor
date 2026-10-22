import { z } from "zod";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";
import { CHIPS, chatState, markMessage, postChat } from "@/server/chat";

/** The project's chat: messages, the workflow stage, running jobs, creator profiles. Also settles finished turns. */
export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  return chatState(await ownedProject(id, userId));
});

const body = z.object({
  text: z.string().trim().min(1).max(4000),
  chip: z.enum(CHIPS).nullish(),
  creator: z.string().nullish(), // "Apply creator style" chip: the profile picked
  json: z.any().optional(), // the editor's current timeline
  plan: z.any().optional(), // the plan screen's table edits
  source: z.enum(["chat", "render", "cut", "stills"]).optional(), // where the notes come from (they become rules first)
});

/** Send a message (or a quick chip). Returns the new messages and, for a Claude turn, its job to stream. */
export const POST = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const project = await ownedProject(id, userId);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Type what you'd like");
  return postChat({ project, text: parsed.data.text, chip: parsed.data.chip, creator: parsed.data.creator, timeline: parsed.data.json, plan: parsed.data.plan, source: parsed.data.source });
});

const patch = z.object({ messageId: z.string(), applied: z.boolean().optional(), dismissed: z.boolean().optional(), ruleSaved: z.string().nullish() });

/** Mark a message's ops applied / dismissed, or its proposed taste rule saved. */
export const PATCH = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const project = await ownedProject(id, userId);
  const parsed = patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Invalid request");
  const { messageId, ...rest } = parsed.data;
  await markMessage(project, messageId, rest);
  return { ok: true };
});
