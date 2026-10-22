import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";
import { backfillNumbers } from "@/server/renders";
import { assertTimeline } from "@/server/validate";

export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  await backfillNumbers(id);
  const versions = await prisma.timelineVersion.findMany({
    where: { projectId: id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      kind: true,
      number: true,
      notes: true,
      createdAt: true,
      _count: { select: { renders: true } },
      // the newest render of each version: its phone preview, full export and thumbnail
      renders: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { id: true, status: true, progress: true, step: true, quality: true, outputUrl: true, previewUrl: true, thumbUrl: true, duration: true, finishedAt: true },
      },
    },
  });
  return { versions };
});

const body = z.object({ name: z.string().trim().min(1).max(80), json: z.any(), kind: z.enum(["manual", "before-restore"]).default("manual") });

/** Named snapshot of the timeline JSON sent by the editor (its current state). */
export const POST = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Give the version a name");
  assertTimeline(parsed.data.json);
  const v = await prisma.timelineVersion.create({
    data: { projectId: id, name: parsed.data.name, kind: parsed.data.kind, json: parsed.data.json as unknown as Prisma.InputJsonValue },
    select: { id: true, name: true, kind: true, createdAt: true },
  });
  return { version: v };
});
