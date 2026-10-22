import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";

type P = { id: string; vid: string };

async function load(ctx: Ctx<P>) {
  const userId = await requireUserId();
  const { id, vid } = await ctx.params;
  const project = await ownedProject(id, userId);
  const version = await prisma.timelineVersion.findFirst({ where: { id: vid, projectId: id } });
  if (!version) throw new HttpError(404, "Version not found");
  return { userId, project, version };
}

/** Full JSON of a version (the editor restores it client-side as an undoable change). */
export const GET = route(async (_req: Request, ctx: Ctx<P>) => {
  const { version } = await load(ctx);
  return { version };
});

const action = z.object({ action: z.enum(["duplicate", "rename", "notes"]), name: z.string().trim().max(80).optional(), notes: z.string().max(4000).optional() });

export const POST = route(async (req: Request, ctx: Ctx<P>) => {
  const { userId, project, version } = await load(ctx);
  const parsed = action.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Unknown action");
  if (parsed.data.action === "notes") {
    await prisma.timelineVersion.update({ where: { id: version.id }, data: { notes: (parsed.data.notes ?? "").trim() || null } });
    return { ok: true };
  }
  if (parsed.data.action === "rename") {
    if (!parsed.data.name) throw new HttpError(400, "Name required");
    await prisma.timelineVersion.update({ where: { id: version.id }, data: { name: parsed.data.name } });
    return { ok: true };
  }
  // duplicate -> a brand-new project whose timeline is this version
  const json = version.json as Prisma.InputJsonValue;
  const voice = await prisma.voiceTrack.findUnique({ where: { projectId: project.id } });
  const copy = await prisma.project.create({
    data: {
      userId,
      title: `${project.title} (${version.name})`.slice(0, 100),
      aspect: project.aspect,
      status: "ready",
      thumbnailUrl: project.thumbnailUrl,
      duration: project.duration,
      timeline: { create: { json } },
      versions: { create: { name: `Copied from “${version.name}”`, kind: "manual", json } },
      voice: voice
        ? {
            create: {
              assetId: voice.assetId,
              url: voice.url,
              duration: voice.duration,
              language: voice.language,
              transcriptJson: voice.transcriptJson ?? undefined,
              status: "done",
            },
          }
        : undefined,
    },
  });
  return { projectId: copy.id };
});

export const DELETE = route(async (_req: Request, ctx: Ctx<P>) => {
  const { version } = await load(ctx);
  const renders = await prisma.renderJob.count({ where: { versionId: version.id } });
  if (renders) throw new HttpError(409, "This version has renders; it's kept as their source");
  await prisma.timelineVersion.delete({ where: { id: version.id } });
  return { ok: true };
});
