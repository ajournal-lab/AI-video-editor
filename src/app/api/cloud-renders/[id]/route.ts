import { rmSync } from "node:fs";
import { z } from "zod";
import { prisma } from "@/server/db";
import { HttpError, requireUserId, route, type Ctx } from "@/server/http";
import { cleanupCloud, cloudDir, cloudDTO } from "@/server/cloud";

async function owned(id: string, userId: string) {
  const row = await prisma.cloudRender.findFirst({ where: { id, userId } });
  if (!row) throw new HttpError(404, "Cloud render not found");
  return row;
}

/** Status of one cloud render (+ the finished export row when it's done). */
export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  let row = await owned(id, userId);
  // the runner job was cancelled / died mid-way: the script couldn't clean up, so say so (and offer "Clean up")
  if (["uploading", "queued", "running", "downloading", "cleaning"].includes(row.status) && row.agentJobId) {
    const job = await prisma.agentJob.findUnique({ where: { id: row.agentJobId }, select: { status: true, error: true } });
    if (job && (job.status === "cancelled" || job.status === "failed"))
      row = await prisma.cloudRender.update({
        where: { id },
        data: { status: job.status, step: "Stopped", error: `${job.error ?? job.status}. Uploads may still be on GitHub: use Clean up.`, finishedAt: new Date() },
      });
  }
  const render = row.renderJobId ? await prisma.renderJob.findUnique({ where: { id: row.renderJobId }, include: { version: { select: { id: true, name: true, number: true, notes: true } } } }) : null;
  return { cloud: cloudDTO(row), render };
});

/** {action: "discard"} a prepared bundle the user didn't confirm · {action: "cleanup"} delete leftovers on GitHub. */
export const POST = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const row = await owned(id, userId);
  const b = z.object({ action: z.enum(["discard", "cleanup"]) }).safeParse(await req.json().catch(() => null));
  if (!b.success) throw new HttpError(400, "Invalid request");
  if (b.data.action === "discard") {
    if (row.status !== "prepared") throw new HttpError(409, "Only an unconfirmed bundle can be discarded");
    rmSync(cloudDir(row.id), { recursive: true, force: true });
    await prisma.cloudRender.update({ where: { id }, data: { status: "cancelled", confirmHash: null, step: "Not uploaded", finishedAt: new Date() } });
    return { ok: true };
  }
  if (["uploading", "queued", "running", "downloading", "cleaning"].includes(row.status)) {
    const job = row.agentJobId ? await prisma.agentJob.findUnique({ where: { id: row.agentJobId } }) : null;
    if (job && (job.status === "running" || job.status === "queued")) throw new HttpError(409, "It's still running: cancel it first");
  }
  return cleanupCloud(row);
});
