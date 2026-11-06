import { z } from "zod";
import { prisma } from "@/server/db";
import { HttpError, requireUserId, route } from "@/server/http";
import { createLinkAsset } from "@/server/audiolink";
import { MODES, startPlan, validateInputs, type ModeInputs } from "@/server/modes";
import { normHandle, readCreatorStyle } from "@/server/style";

export const maxDuration = 300; // Vercel Hobby limit; a pasted sound link is downloaded before the plan starts (no limit on a local install)

export const GET = route(async () => {
  const userId = await requireUserId();
  const projects = await prisma.project.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, aspect: true, status: true, thumbnailUrl: true, duration: true, updatedAt: true, isSample: true, pipeline: true },
  });
  return { projects: projects.map(({ pipeline, ...p }) => ({ ...p, creator: (pipeline as { creator?: string | null } | null)?.creator ?? null })) };
});

const body = z.object({
  title: z.string().trim().max(100).optional(),
  aspect: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
  mode: z.enum(["voice", "music", "talking_head", "best_take", "voiceover_broll", "auto_clip"]).default("voice"),
  // edit modes: role -> asset ids, plus options (see ModeInputs)
  inputs: z
    .object({
      assets: z.record(z.string(), z.array(z.string()).max(60)),
      script: z.string().max(8000).optional(),
      musicUrl: z.string().url().max(500).optional(),
      notes: z.string().max(2000).optional(),
      faceCutbacks: z.boolean().optional(),
      count: z.number().int().min(1).max(10).optional(),
      minSec: z.number().min(5).max(180).optional(),
      maxSec: z.number().min(5).max(180).optional(),
      grade: z.object({ look: z.enum(["cinematic_warm"]), intensity: z.number().min(0).max(1) }).optional(),
      creator: z.string().max(61).nullish(), // a creator profile: its style.json guides the plan and the stage-2 style pass
    })
    .optional(),
  prompt: z.string().trim().max(6000).optional(),
  visualMode: z.enum(["auto", "ai", "stock"]).default("auto"),
  assetIds: z.array(z.string()).max(100).default([]),
  // edit modes: open the project on its chat instead of planning right away (the first message starts the cut)
  startInChat: z.boolean().optional(),
});

export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) throw new HttpError(400, "Invalid project");
  const { mode, inputs } = parsed.data;
  if (mode !== "voice") {
    if (!inputs) throw new HttpError(400, "Add the inputs for this mode");
    validateInputs(mode, inputs as ModeInputs);
    // a pasted sound link (Instagram /reel/, YouTube, Shorts, .mp3) becomes the music input, like the editor's Paste link
    if (inputs.musicUrl && MODES[mode].roles.music && !(inputs.assets.music ?? []).length) {
      const asset = await createLinkAsset(userId, inputs.musicUrl);
      inputs.assets.music = [asset.id];
    }
    const ids = [...new Set(Object.values(inputs.assets).flat())];
    const owned = await prisma.mediaAsset.count({ where: { id: { in: ids }, userId } });
    if (owned !== ids.length) throw new HttpError(400, "Some inputs are not in your library");
    const draft = Boolean(parsed.data.startInChat);
    const creator = inputs.creator ? normHandle(inputs.creator) : null;
    if (creator && !readCreatorStyle(creator)) throw new HttpError(400, `@${creator} has no finished style profile yet`);
    inputs.creator = creator;
    const project = await prisma.project.create({
      data: {
        userId,
        title: parsed.data.title || "Untitled video",
        aspect: parsed.data.aspect,
        mode,
        inputs,
        assetIds: ids,
        status: draft ? "draft" : "planning",
        // two-stage approval: stage 1 is the spoken cut; with a creator, the style pass runs once the cut is approved
        pipeline: { stage: "cut", creator, pendingStyle: Boolean(creator), brief: "" },
      },
    });
    if (!draft) await startPlan(project);
    return { project: { id: project.id } };
  }
  const project = await prisma.project.create({
    data: {
      userId,
      title: parsed.data.title || "Untitled video",
      aspect: parsed.data.aspect,
      mode: parsed.data.mode,
      prompt: parsed.data.prompt || null,
      visualMode: parsed.data.visualMode,
      // only the caller's own media
      assetIds: (await prisma.mediaAsset.findMany({ where: { id: { in: parsed.data.assetIds }, userId }, select: { id: true } })).map((a) => a.id),
    },
    select: { id: true },
  });
  return { project };
});
