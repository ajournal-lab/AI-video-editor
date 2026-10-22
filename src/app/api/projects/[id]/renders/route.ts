import { z } from "zod";
import { prisma } from "@/server/db";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";
import { queueRender } from "@/server/renders";

export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  const renders = await prisma.renderJob.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    include: { version: { select: { id: true, name: true, number: true, notes: true } } },
  });
  return { renders };
});

const body = z.object({
  quality: z.enum(["720p", "1080p"]).default("1080p"),
  versionId: z.string().optional(),
  json: z.any().optional(), // current editor state; snapshotted as the render's version
});

/**
 * Queue a render. Every render points at an immutable TimelineVersion: either the
 * one given, or a fresh "Render" snapshot of the timeline the editor sent.
 * Projects in the two-stage workflow need their key stills approved first (409 otherwise).
 */
export const POST = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const project = await ownedProject(id, userId);
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) throw new HttpError(400, "Invalid render request");
  const { render, changedSinceStills } = await queueRender(project, userId, parsed.data);
  return { render, changedSinceStills };
});
