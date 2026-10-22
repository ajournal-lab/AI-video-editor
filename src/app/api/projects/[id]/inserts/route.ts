import { z } from "zod";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";
import { listInserts, queueInserts } from "@/server/inserts";
import type { InsertSpec } from "@/lib/timeline/types";

/** Status of every insert of the project (the editor polls this while some are building). */
export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  return { inserts: await listInserts(id) };
});

const spec = z.object({
  kind: z.enum(["app_screen", "follow_cta", "scroll_file", "ui_demo", "orbit"]),
  duration: z.number().min(0.5).max(30),
  width: z.number().int().min(16).max(4096),
  height: z.number().int().min(16).max(4096),
  fps: z.number().int().min(1).max(120),
  src: z.string().max(2000).nullish(),
  srcType: z.enum(["image", "video"]).nullish(),
  handle: z.string().max(60).nullish(),
  name: z.string().max(80).nullish(),
  avatar: z.string().max(2000).nullish(),
  taps: z.array(z.object({ t: z.number(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).max(20).nullish(),
  title: z.string().max(120).nullish(),
  sources: z.array(z.string().max(2000)).max(8).nullish(),
});

/** Queue inserts (by spec; already built or building ones are left alone, failed ones retried). */
export const POST = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  const parsed = z.object({ specs: z.array(spec).max(40) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Invalid insert");
  return { inserts: await queueInserts(id, userId, parsed.data.specs as InsertSpec[]) };
});
