import { z } from "zod";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";
import { approveStills, ensurePipeline, getPipeline, renderGate, startStills, startStyle, STAGE_LABEL, styleApplied, syncPipeline } from "@/server/pipeline";
import { prisma } from "@/server/db";
import { jobDTO } from "@/server/agent";
import { assertTimeline } from "@/server/validate";
import type { Fix } from "@/lib/chat/fixes";
import type { Timeline } from "@/lib/timeline/types";

/** Two-stage approval state: stage, style pass ops (for the editor to apply), stills, conflicts, render gate. */
export const GET = route(async (_req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const project = await ownedProject(id, userId);
  const pipeline = await syncPipeline(project);
  const p = (await prisma.project.findUnique({ where: { id } }))!;
  const tl = (await prisma.timeline.findUnique({ where: { projectId: id } }))?.json as unknown as Timeline | undefined;
  return { pipeline, stageLabel: pipeline ? STAGE_LABEL[pipeline.stage] : null, gate: renderGate(p, tl ?? null) };
});

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("style"), creator: z.string().nullish(), brief: z.string().max(4000).optional(), json: z.any() }),
  z.object({ action: z.literal("style_applied"), jobId: z.string(), json: z.any() }),
  z.object({ action: z.literal("stills"), json: z.any() }),
  z.object({ action: z.literal("approve_stills") }),
  // per-still notes: one style revision with every note as a timestamped fix
  z.object({ action: z.literal("fix_stills"), notes: z.array(z.object({ t: z.number(), text: z.string().min(1).max(500) })).min(1), json: z.any() }),
  z.object({ action: z.literal("gate"), json: z.any() }),
]);

export const POST = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const project = await ownedProject(id, userId);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Invalid request");
  const b = parsed.data;
  const tl = () => {
    const j = (b as { json?: unknown }).json;
    assertTimeline(j);
    return j as Timeline;
  };
  switch (b.action) {
    case "style":
      await ensurePipeline(project);
      return { job: jobDTO(await startStyle((await prisma.project.findUnique({ where: { id } }))!, { timeline: tl(), creator: b.creator ?? null, brief: b.brief ?? "", notes: Boolean(b.brief?.trim()) })) };
    case "style_applied":
      return { job: jobDTO(await styleApplied(project, b.jobId, tl())) };
    case "stills":
      return { job: jobDTO(await startStills(project, tl(), getPipeline(project)?.style?.picks)) };
    case "approve_stills":
      return { pipeline: await approveStills(project) };
    case "fix_stills": {
      const fixes: Fix[] = b.notes.map((n) => ({ at: n.t, end: null, label: `${n.t.toFixed(1)}s`, text: n.text }));
      return { job: jobDTO(await startStyle(project, { timeline: tl(), fixes, revise: true, notes: true })) };
    }
    case "gate":
      return renderGate(project, tl());
  }
});
