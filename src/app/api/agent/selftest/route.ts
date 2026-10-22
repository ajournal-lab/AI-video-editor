import { z } from "zod";
import { prisma } from "@/server/db";
import { createJob, jobDTO, timelineMediaFiles } from "@/server/agent";
import { HttpError, ownedProject, requireUserId, route } from "@/server/http";
import { checklistPath, fwd, gotchasPath } from "@/agent/config";
import type { Timeline } from "@/lib/timeline/types";

const body = z.object({ projectId: z.string() });

/**
 * Runner self-check on a real project: Claude probes every media file with ffprobe
 * and writes media-check.json (validated). Exercises spawn, streaming, the tool
 * allowlist, schema validation and cancel end to end.
 */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "projectId is required");
  const project = await ownedProject(parsed.data.projectId, userId);
  const tl = (await prisma.timeline.findUnique({ where: { projectId: project.id } }))?.json as unknown as Timeline | undefined;
  const files = tl ? timelineMediaFiles(tl) : [];
  if (!files.length) throw new HttpError(400, "This project has no local media files yet");

  const job = await createJob({
    userId,
    projectId: project.id,
    kind: "selftest",
    title: "Self-check: probe media",
    outputFile: "media-check.json",
    schema: "media-check",
    freshOutput: true,
    timeoutSec: 600,
    prompt: `Self-check of the ReelSmith agent runner.

1. Read ${fwd(checklistPath())} and ${fwd(gotchasPath())}.
2. Run ffprobe on each media file below (one Bash call per file), for example:
   ffprobe -v error -show_entries format=duration:stream=codec_type,width,height,r_frame_rate -of json "<file>"
3. Write media-check.json:
   { "files": [ { "name": file name, "path": absolute path with forward slashes, "kind": "video" | "audio" | "image",
                  "durationSec": number|null, "width": int|null, "height": int|null, "fps": number|null,
                  "hasAudio": boolean, "orientation": "vertical" | "horizontal" | "square" | null } ],
     "summary": one or two sentences about the footage, then "taste checklist: N rules, gotchas: M loaded" }

Files:
${files.map((f) => `- ${fwd(f)}`).join("\n")}`,
  });
  return { job: jobDTO(job) };
});
