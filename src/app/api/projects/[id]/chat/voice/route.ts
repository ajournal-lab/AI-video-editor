import crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Prisma } from "@prisma/client";
import { appDir, workerPython } from "@/agent/config";
import { createJob, ensureProjectDir, jobDTO } from "@/server/agent";
import { prisma } from "@/server/db";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";

const MAX_BYTES = 25 * 1024 * 1024;
const EXT: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav" };

/**
 * A voice note from the chat mic (multipart "audio"). It is transcribed locally (worker/voice_note.py, faster-whisper on the
 * CPU, as a local job in the agent runner's queue) and then goes through the chat like a typed message, so the note becomes
 * a taste-checklist rule in your words before anything changes (R2).
 */
export const POST = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  const project = await ownedProject(id, userId);
  const form = await req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof Blob) || !file.size) throw new HttpError(400, "No recording received");
  if (file.size > MAX_BYTES) throw new HttpError(413, "That voice note is too long (max 25 MB)");
  const type = (file.type || "audio/webm").split(";")[0];
  const ext = EXT[type];
  if (!ext) throw new HttpError(415, `Unsupported audio type ${type}`);

  const dir = path.join(ensureProjectDir(project.id), "chat", "voice");
  mkdirSync(dir, { recursive: true });
  const jid = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const src = path.join(dir, `${jid}.${ext}`);
  writeFileSync(src, Buffer.from(await file.arrayBuffer()));
  const job = await createJob({
    id: jid,
    userId,
    projectId: project.id,
    kind: "voice_note",
    title: "Transcribe a voice note",
    prompt: "(local command)",
    exec: [workerPython(), path.join(appDir(), "worker", "voice_note.py"), src, path.join(dir, `${jid}.json`)],
    timeoutSec: 10 * 60,
  });
  const message = await prisma.chatMessage.create({
    data: {
      projectId: project.id,
      userId,
      role: "step",
      text: "Transcribing your voice note (locally)",
      jobId: job.id,
      data: { steps: [{ type: "note", label: "Voice note", jobId: job.id }], voice: { jobId: job.id, consumed: false } } as Prisma.InputJsonValue,
    },
  });
  return { job: jobDTO(job), message };
});
