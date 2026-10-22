import { requireUserId, route, type Ctx } from "@/server/http";
import { creatorDetail, deleteCreator } from "@/server/creators";

/** One profile: status + jobs, style.json, teardown.md, measurements (per video + aggregate). */
export const GET = route(async (_req: Request, ctx: Ctx<{ handle: string }>) => {
  await requireUserId();
  const { handle } = await ctx.params;
  return creatorDetail(decodeURIComponent(handle));
});

/** Delete the profile folder (downloads, sheets, results). */
export const DELETE = route(async (_req: Request, ctx: Ctx<{ handle: string }>) => {
  await requireUserId();
  const { handle } = await ctx.params;
  deleteCreator(decodeURIComponent(handle));
  return { ok: true };
});
