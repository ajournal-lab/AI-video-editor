import "server-only";
// Looks on the server (src/lib/timeline/looks.ts does the work): the client's default look on new timelines, the
// user's own reels for the Cool girl orbit, and applying stale looks (+ queuing the speaker cut-out) before a render.
import type { Prisma } from "@prisma/client";
import { applyLooks, detectScriptCues, EMPTY_LOOKS, looksStale } from "@/lib/timeline/looks";
import { matteWindows } from "@/lib/timeline/matte";
import type { Timeline, VisualClip } from "@/lib/timeline/types";
import { prisma } from "./db";
import { queueMatte } from "./matte";
import { getSettings } from "./settings";

/** The user's latest finished reels from other projects (phone previews: small and quick to read), newest first. */
export async function myReels(userId: string, exceptProject: string | null, limit = 12) {
  const rows = await prisma.renderJob.findMany({
    where: { userId, status: "done", ...(exceptProject ? { projectId: { not: exceptProject } } : {}) },
    orderBy: { finishedAt: "desc" },
    take: 80,
    select: { id: true, outputUrl: true, previewUrl: true, thumbUrl: true, finishedAt: true, projectId: true, project: { select: { title: true } } },
  });
  const seen = new Set<string>();
  const out: { url: string; thumb: string | null; title: string; renderId: string }[] = [];
  for (const r of rows) {
    if (seen.has(r.projectId) || !(r.previewUrl ?? r.outputUrl)) continue;
    seen.add(r.projectId);
    out.push({ url: (r.previewUrl ?? r.outputUrl)!, thumb: r.thumbUrl, title: r.project.title, renderId: r.id });
    if (out.length >= limit) break;
  }
  return out;
}

export const defaultOrbitSources = async (userId: string, projectId: string) => (await myReels(userId, projectId, 4)).map((r) => r.url);

/** A new timeline starts with the client's default look (brand kit), if one is set. Mutates tl. */
export async function withClientLook(userId: string, tl: Timeline) {
  const kit = (await getSettings(userId)).brandKit;
  if (kit?.enabled && kit.look && !tl.looks) tl.looks = { ...EMPTY_LOOKS, default: kit.look };
  return tl;
}

/** Queue mattes for the Cut-out copies that have none (mutates the clips: matte = {on:false, jobId}). */
export async function queueLookMattes(userId: string, projectId: string, tl: Timeline, ids: string[]) {
  if (!ids.length) return;
  const want = new Set(ids);
  const copies = tl.tracks.flatMap((t) => (t.kind === "video" ? t.clips.filter((c) => want.has(c.id)) : [])) as VisualClip[];
  for (const w of matteWindows(copies)) {
    try {
      const q = await queueMatte(userId, projectId, w.src, w.srcIn, w.srcLen, w.name);
      for (const c of copies) if (c.src === w.src) c.matte = { on: q.job.status === "done", url: q.url, srcIn: q.srcIn, srcLen: q.srcLen, fps: 0, jobId: q.job.status === "done" ? null : q.job.id };
    } catch {
      /* not local media: those copies stay without a matte and are skipped in the render */
    }
  }
}

/** Before a render (or a server-side change): rebuild stale looks and queue any missing cut-out. */
export async function ensureLooks(userId: string, projectId: string, tl: Timeline): Promise<{ tl: Timeline; changed: boolean }> {
  if (!tl.looks && !detectScriptCues(tl).length) return { tl, changed: false };
  if (tl.looks && !looksStale(tl)) return { tl, changed: false };
  const r = applyLooks(tl, { defaultOrbitSources: await defaultOrbitSources(userId, projectId) });
  await queueLookMattes(userId, projectId, r.tl, r.needsMatte);
  await prisma.timeline.update({ where: { projectId }, data: { json: r.tl as unknown as Prisma.InputJsonValue, revision: { increment: 1 } } });
  return { tl: r.tl, changed: true };
}
