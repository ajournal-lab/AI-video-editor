import { z } from "zod";
import { prisma } from "@/server/db";
import { jobDTO } from "@/server/agent";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";
import { MODES, isPlanMode, revisePlan, startPlan, syncPlanStatus, type ModeInputs } from "@/server/modes";

/** Plan state for the review screen: status, the plan (once valid), the running job, the inputs. */
export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const project = await syncPlanStatus(await ownedProject(id, userId));
  if (!isPlanMode(project.mode)) throw new HttpError(400, "This project has no plan");
  const inputs = project.inputs as unknown as ModeInputs;
  const assets = await prisma.mediaAsset.findMany({
    where: { userId, id: { in: Object.values(inputs.assets).flat() } },
    select: { id: true, type: true, url: true, thumbUrl: true, name: true, duration: true, width: true, height: true },
  });
  const job = project.planJobId ? await prisma.agentJob.findUnique({ where: { id: project.planJobId } }) : null;
  const children = project.mode === "auto_clip" ? await prisma.project.findMany({ where: { parentId: id, userId }, select: { id: true, title: true, thumbnailUrl: true, duration: true } }) : [];
  return {
    project: { id: project.id, title: project.title, mode: project.mode, modeLabel: MODES[project.mode].label, status: project.status, statusMessage: project.statusMessage, aspect: project.aspect },
    plan: project.plan,
    job: job ? jobDTO(job) : null,
    inputs,
    assets,
    children,
  };
});

const body = z.object({ feedback: z.string().trim().min(2).max(4000), plan: z.any() });

/** Feedback on the plan: save the user's table edits and resume Claude's session to revise it. Or {retry:true}. */
export const POST = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const project = await ownedProject(id, userId);
  if (!isPlanMode(project.mode)) throw new HttpError(400, "This project has no plan");
  const raw = await req.json().catch(() => null);
  if (raw?.retry) {
    if (project.status !== "plan_failed") throw new HttpError(409, "The plan isn't failed");
    return { job: jobDTO(await startPlan(project)) };
  }
  if (project.status !== "review") throw new HttpError(409, "Wait until the plan is ready");
  const parsed = body.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Write what you'd like to change");
  // the user's own notes on the cut: the revision files them as rules first (taste checklist R2)
  return { job: jobDTO(await revisePlan(project, parsed.data.feedback, parsed.data.plan, { notes: true })) };
});
