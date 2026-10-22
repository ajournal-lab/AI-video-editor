import { z } from "zod";
import { prisma } from "@/server/db";
import { maybeBuildFirstCut } from "@/server/firstcut";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";
import { deleteObject } from "@/server/storage";

export const maxDuration = 300;

/**
 * Status for the processing screen. When the worker has finished transcribing,
 * the first request to see it builds the first cut (scene split + library matching).
 */
export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  await maybeBuildFirstCut(id);
  const project = await prisma.project.findUniqueOrThrow({
    where: { id },
    select: { id: true, title: true, status: true, statusMessage: true, aspect: true, thumbnailUrl: true, duration: true },
  });
  const voice = await prisma.voiceTrack.findUnique({ where: { projectId: id }, select: { status: true, error: true, createdAt: true, updatedAt: true } });
  return {
    project,
    voice: voice && { ...voice, queuedFor: voice.status === "queued" ? (Date.now() - voice.updatedAt.getTime()) / 1000 : 0 },
  };
});

const patch = z.object({ title: z.string().trim().min(1).max(100) });

export const PATCH = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  const parsed = patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Invalid title");
  await prisma.project.update({ where: { id }, data: { title: parsed.data.title } });
  return { ok: true };
});

export const DELETE = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  const renders = await prisma.renderJob.findMany({ where: { projectId: id }, select: { outputKey: true, previewKey: true } });
  await prisma.project.delete({ where: { id } });
  await Promise.all(renders.flatMap((r) => [r.outputKey, r.previewKey]).filter(Boolean).map((k) => deleteObject(k!)));
  return { ok: true };
});
