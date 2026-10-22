import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { prisma } from "@/server/db";
import { aiEditInput, aiEditPrompt, resolveAiEdit } from "@/server/aiedit";
import crypto from "node:crypto";
import { createJob, ensureProjectDir, jobDTO, lastSession, readResult } from "@/server/agent";
import { absorbNotes, notesBlock } from "@/server/rules";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";
import { assertTimeline } from "@/server/validate";
import { aiEditSchema, type AiEditResult } from "@/agent/schemas";
import { fwd } from "@/agent/config";
import type { Timeline } from "@/lib/timeline/types";

const body = z.object({ command: z.string().trim().min(2).max(500), json: z.any() });

/** Natural-language command -> a Claude job that writes ai-edit.json. Returns the job to stream. */
export const POST = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Type what you'd like to change");
  assertTimeline(parsed.data.json);
  const tl = parsed.data.json as Timeline;

  const dir = ensureProjectDir(id);
  writeFileSync(path.join(dir, "edit", "ai-timeline.json"), JSON.stringify(aiEditInput(tl), null, 1));
  const jid = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const job = await createJob({
    id: jid,
    userId,
    projectId: id,
    kind: "ai_edit",
    title: `AI edit: ${parsed.data.command.slice(0, 80)}`,
    // the command is the user's own note: it becomes a taste-checklist rule first when it states a preference (R2)
    prompt: `${aiEditPrompt(parsed.data.command, `${fwd(dir)}/edit/ai-timeline.json`)}
${notesBlock(dir, jid, "ai_edit")}`,
    resumeSessionId: await lastSession(id, "ai_edit"),
    outputFile: "ai-edit.json",
    schema: "ai-edit",
    freshOutput: true,
    timeoutSec: 300,
  });
  // the exact timeline the ops refer to, for resolving replace_visual afterwards
  writeFileSync(path.join(dir, "jobs", `${job.id}.base.json`), JSON.stringify(tl));
  return { job: jobDTO(job) };
});

/** ?jobId= -> the validated ops of a finished ai_edit job, with replace_visual resolved to library media. */
export const GET = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const project = await ownedProject(id, userId);
  const jobId = new URL(req.url).searchParams.get("jobId") ?? "";
  const job = await prisma.agentJob.findFirst({ where: { id: jobId, projectId: id, userId, kind: "ai_edit" } });
  if (!job) throw new HttpError(404, "Job not found");
  await absorbNotes(project, job.id, "ai_edit");
  if (job.status !== "done") throw new HttpError(409, job.error ?? `The job is ${job.status}`);
  const res = aiEditSchema.safeParse(readResult<AiEditResult>(id, "ai-edit.json"));
  if (!res.success) throw new HttpError(500, "ai-edit.json is missing or invalid");
  const basePath = path.join(ensureProjectDir(id), "jobs", `${job.id}.base.json`);
  const base = existsSync(basePath) ? (JSON.parse(readFileSync(basePath, "utf8")) as Timeline) : null;
  if (!base) throw new HttpError(500, "The timeline snapshot for this job is missing");
  return resolveAiEdit(userId, base, res.data);
});
