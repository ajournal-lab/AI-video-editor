import { ownedProject, requireUserId, route, type Ctx } from "@/server/http";
import { myReels } from "@/server/looks";
import { getSettings } from "@/server/settings";

/** For the Looks panel: the user's own reels (Cool girl orbit) and the client's default look / handle (brand kit). */
export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  const kit = (await getSettings(userId)).brandKit;
  return { reels: await myReels(userId, id), clientLook: kit?.enabled ? (kit.look ?? null) : null, handle: kit?.enabled ? (kit.handle ?? null) : null };
});
