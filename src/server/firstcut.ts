import "server-only";
import type { MediaAsset, Prisma } from "@prisma/client";
import { emptyTimeline, newAudioClip, newTextClip, newVisualClip } from "@/lib/timeline/factory";
import type { Aspect, Timeline, VisualClip, VoiceTrack as VoiceTrackT, VideoTrack, TextTrack, Word } from "@/lib/timeline/types";
import { prisma } from "./db";
import { splitScenes } from "./scenes";
import { clipFromAsset, pickVisual, scoreAsset } from "./visuals";
import { withClientLook } from "./looks";

type Transcript = { words: Word[]; duration?: number; language?: string };

/** transcript -> scenes -> matched visuals (your library, else gradient cards) -> timeline JSON (the "first cut"). */
export async function buildFirstCut(projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, include: { voice: true } });
  const voice = project.voice;
  if (!voice?.transcriptJson) throw new Error("No transcript yet");
  const transcript = voice.transcriptJson as unknown as Transcript;
  const words = transcript.words ?? [];
  const aspect = project.aspect as Aspect;
  const duration = voice.duration ?? transcript.duration ?? (words.length ? words[words.length - 1].end + 0.5 : 5);

  const split = splitScenes(words, duration);
  const library = await prisma.mediaAsset.findMany({
    where: { userId: project.userId, type: { in: ["video", "image"] } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });

  const used = new Set<string>();
  const scenes = split.scenes;

  // 0) Media the user attached to this project always goes in: best keyword match
  //    first, then any leftovers spread over the scenes that still have nothing.
  const attached = project.assetIds.length
    ? await prisma.mediaAsset.findMany({ where: { id: { in: project.assetIds }, userId: project.userId, type: { in: ["video", "image"] } } })
    : [];
  attached.sort((x, y) => project.assetIds.indexOf(x.id) - project.assetIds.indexOf(y.id));
  const assigned = new Map<number, MediaAsset>();
  const pairs = scenes.flatMap((s, i) => attached.map((a) => ({ i, a, score: scoreAsset(a, s.visual_keywords) })));
  for (const p of pairs.filter((p) => p.score > 0).sort((x, y) => y.score - x.score)) {
    if (!assigned.has(p.i) && !used.has(p.a.id)) {
      assigned.set(p.i, p.a);
      used.add(p.a.id);
    }
  }
  const leftovers = attached.filter((a) => !used.has(a.id));
  const free = scenes.map((_, i) => i).filter((i) => !assigned.has(i));
  leftovers.forEach((a, k) => {
    if (!free.length) return;
    const idx = free[Math.min(free.length - 1, Math.floor((k * free.length) / leftovers.length))];
    if (assigned.has(idx)) return;
    assigned.set(idx, a);
    used.add(a.id);
  });

  const visuals: VisualClip[] = [];
  // Sequential on purpose: keeps "used" consistent so scenes don't repeat a shot.
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    // A video shorter than its scene gets followed by another shot until the scene is filled.
    let cursor = s.start;
    for (let shot = 0; shot < 3 && s.end - cursor > 0.1; shot++) {
      const dur = s.end - cursor;
      const extra = {
        scene: i + 1,
        keywords: s.visual_keywords,
        name: `Scene ${i + 1}`,
        visualHint: `${s.image_prompt.replace(/[.\s]+$/, "")}${split.style ? `. Style: ${split.style}` : ""}`,
      };
      const mine = shot === 0 ? assigned.get(i) : undefined;
      const pick = mine
        ? { asset: mine }
        : pickVisual({ library, keywords: s.visual_keywords, used, index: i + shot });
      const clip = pick.asset
        ? clipFromAsset(pick.asset, cursor, dur, { ...extra, name: `Scene ${i + 1} · ${mine ? pick.asset.name : s.query || pick.asset.name}` })
        : newVisualClip({ type: "color", start: cursor, duration: dur, colors: pick.colors, ...extra });
      if (shot === 2 || !pick.asset) clip.duration = dur; // hold the final frame / fill the scene
      visuals.push(clip);
      cursor += clip.duration;
    }
  }

  const tl: Timeline = emptyTimeline(aspect);
  const assetId = voice.assetId ?? voice.id;
  tl.transcripts[assetId] = { words };
  (tl.tracks.find((t) => t.kind === "video") as VideoTrack).clips = visuals;
  (tl.tracks.find((t) => t.kind === "voice") as VoiceTrackT).clips = [
    newAudioClip({ src: voice.url, assetId, name: "Voiceover", start: 0, duration, srcDuration: duration }),
  ];
  if (split.title && split.title !== "Untitled") {
    const title = newTextClip("title", 0, aspect, split.title);
    title.duration = Math.min(3, Math.max(1.5, split.scenes[0]?.end ?? 3));
    (tl.tracks.find((t) => t.kind === "text") as TextTrack).clips = [title];
  }

  const firstThumb = visuals.find((v) => v.thumb)?.thumb ?? null;
  await withClientLook(project.userId, tl); // the client's default look (brand kit); the editor builds it
  const json = tl as unknown as Prisma.InputJsonValue;
  await prisma.$transaction([
    prisma.timeline.upsert({
      where: { projectId },
      create: { projectId, json },
      update: { json, revision: { increment: 1 } },
    }),
    prisma.timelineVersion.create({ data: { projectId, name: "First cut", kind: "first-cut", json } }),
    prisma.project.update({
      where: { id: projectId },
      data: {
        status: "ready",
        statusMessage: null,
        duration,
        thumbnailUrl: project.thumbnailUrl ?? firstThumb,
        title: project.title === "Untitled video" && split.title ? split.title.slice(0, 80) : project.title,
      },
    }),
  ]);
  return tl;
}

/**
 * Called from status polling: whichever request first sees a finished transcript
 * claims the build (stale claims older than 2 minutes are retried).
 */
export async function maybeBuildFirstCut(projectId: string) {
  const claimed = await prisma.project.updateMany({
    where: {
      id: projectId,
      OR: [{ status: "transcribed" }, { status: "building", buildStartedAt: { lt: new Date(Date.now() - 120_000) } }],
    },
    data: { status: "building", buildStartedAt: new Date() },
  });
  if (!claimed.count) return false;
  try {
    await buildFirstCut(projectId);
  } catch (err) {
    console.error("[first-cut] failed", err);
    await prisma.project.update({
      where: { id: projectId },
      data: { status: "failed", statusMessage: `Couldn't build the first cut: ${(err as Error).message}`.slice(0, 300) },
    });
  }
  return true;
}
