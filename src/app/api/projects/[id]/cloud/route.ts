import { z } from "zod";
import { prisma } from "@/server/db";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";
import { cloudDTO, prepareCloud, startCloud } from "@/server/cloud";
import { getSettings } from "@/server/settings";

/** This project's cloud renders + whether the feature is switched on. */
export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  const s = await getSettings(userId);
  const rows = await prisma.cloudRender.findMany({ where: { projectId: id, NOT: { status: "prepared" } }, orderBy: { createdAt: "desc" }, take: 10 });
  return { enabled: s.cloud.enabled, repo: s.cloud.repo, keep: s.cloud.keep, tokenSet: Boolean(process.env.CLOUD_RENDER_TOKEN), cloud: rows.map(cloudDTO) };
});

const body = z.discriminatedUnion("action", [
  // 1) local only: build the bundle, check the repo is private, return what would be uploaded + a one-time token
  z.object({ action: z.literal("prepare"), quality: z.enum(["720p", "1080p"]).default("1080p"), json: z.any().optional(), keep: z.boolean().optional() }),
  // 2) the user clicked "Upload and render" in the confirmation dialog
  z.object({ action: z.literal("start"), cloudId: z.string(), token: z.string().min(10), keep: z.boolean().optional(), confirm: z.literal(true) }),
]);

export const POST = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const project = await ownedProject(id, userId);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Invalid request (cloud renders need an explicit confirmation)");
  const b = parsed.data;
  if (b.action === "prepare") return prepareCloud(project, userId, { quality: b.quality, json: b.json, keep: b.keep });
  return startCloud(project, userId, b.cloudId, b.token, b.keep);
});
