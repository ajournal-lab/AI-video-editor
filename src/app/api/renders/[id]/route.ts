import { prisma } from "@/server/db";
import { HttpError, requireUserId, route, type Ctx } from "@/server/http";
import { deleteObject } from "@/server/storage";

export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const render = await prisma.renderJob.findFirst({
    where: { id, userId },
    include: { version: { select: { id: true, name: true, number: true, notes: true } } },
  });
  if (!render) throw new HttpError(404, "Render not found");
  // Queue position helps explain waits when the worker is busy.
  const ahead =
    render.status === "queued"
      ? await prisma.renderJob.count({ where: { status: { in: ["queued", "processing"] }, createdAt: { lt: render.createdAt } } })
      : 0;
  return { render, ahead };
});

export const DELETE = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const render = await prisma.renderJob.findFirst({ where: { id, userId } });
  if (!render) throw new HttpError(404, "Render not found");
  if (render.status === "processing") throw new HttpError(409, "Wait for the render to finish");
  if (render.outputKey) await deleteObject(render.outputKey);
  if (render.previewKey) await deleteObject(render.previewKey);
  await prisma.renderJob.delete({ where: { id } });
  return { ok: true };
});
