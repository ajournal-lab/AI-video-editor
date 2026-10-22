import "server-only";
import type { Prisma, Project } from "@prisma/client";
import type { Timeline } from "@/lib/timeline/types";
import { describeChanges } from "@/lib/timeline/changes";
import { prisma } from "./db";
import { HttpError } from "./http";
import { resolveInserts } from "./inserts";
import { ensureLooks } from "./looks";
import { renderGate } from "./pipeline";
import { assertTimeline } from "./validate";

/** What the user asked for in the chat since the previous numbered version (newest last, short). */
async function chatSince(projectId: string, since: Date | null) {
  const msgs = await prisma.chatMessage.findMany({
    where: { projectId, role: "user", ...(since ? { createdAt: { gt: since } } : {}) },
    orderBy: { createdAt: "asc" },
    take: 8,
    select: { text: true },
  });
  return msgs.map((m) => `You asked: “${m.text.replace(/\s+/g, " ").slice(0, 140)}”`);
}

/**
 * Save the editor's timeline (if sent) and snapshot it as an immutable numbered version ("v3 · Oct 12, 11:30") with
 * notes: what changed since the previous numbered version + what was asked in the chat meanwhile. Inserts are queued
 * and the built ones written into the snapshot.
 */
export async function renderVersion(project: Pick<Project, "id" | "userId">, json: unknown | undefined) {
  const projectId = project.id;
  let tl = json;
  if (tl) {
    assertTimeline(tl);
    await prisma.timeline.update({ where: { projectId }, data: { json: tl as unknown as Prisma.InputJsonValue, revision: { increment: 1 } } });
  } else {
    tl = (await prisma.timeline.findUnique({ where: { projectId } }))?.json;
  }
  if (!tl) throw new HttpError(400, "Nothing to render yet");
  // looks out of date (the edit changed since they were built, or a chat/server change): rebuild before the snapshot
  tl = (await ensureLooks(project.userId, projectId, tl as Timeline)).tl;
  const snap = await resolveInserts(projectId, project.userId, tl as Timeline);
  await backfillNumbers(projectId);
  const prev = await prisma.timelineVersion.findFirst({ where: { projectId, number: { not: null } }, orderBy: { number: "desc" } });
  const n = (prev?.number ?? 0) + 1;
  const notes = [...describeChanges((prev?.json as unknown as Timeline) ?? null, snap), ...(await chatSince(projectId, prev?.createdAt ?? null))];
  const stamp = new Date().toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const v = await prisma.timelineVersion.create({
    data: { projectId, name: `v${n} · ${stamp}`, kind: "render", number: n, notes: notes.join("\n"), json: snap as unknown as Prisma.InputJsonValue },
  });
  return { version: v, timeline: snap };
}

/** Number the render versions made before versions were numbered (oldest = v1), once per project. */
export async function backfillNumbers(projectId: string) {
  const missing = await prisma.timelineVersion.findMany({ where: { projectId, kind: "render", number: null }, orderBy: { createdAt: "asc" }, select: { id: true, json: true } });
  if (!missing.length) return;
  const max = (await prisma.timelineVersion.aggregate({ where: { projectId }, _max: { number: true } }))._max.number ?? 0;
  const all = await prisma.timelineVersion.findMany({ where: { projectId, kind: "render" }, orderBy: { createdAt: "asc" }, select: { id: true, number: true, json: true } });
  let n = max;
  let prev: Timeline | null = null;
  for (const v of all) {
    if (v.number == null) {
      n += 1;
      await prisma.timelineVersion.update({ where: { id: v.id }, data: { number: n, notes: describeChanges(prev, v.json as unknown as Timeline).join("\n") } });
    }
    prev = v.json as unknown as Timeline;
  }
}

/**
 * Queue a local render. Projects that went through the style pass render only after the stills are approved
 * (two-stage approval); `versionId` re-renders an existing version.
 */
export async function queueRender(project: Project, userId: string, o: { quality: "720p" | "1080p"; versionId?: string; json?: unknown }) {
  let vid = o.versionId;
  let tl: Timeline | null = null;
  if (vid) {
    const v = await prisma.timelineVersion.findFirst({ where: { id: vid, projectId: project.id } });
    if (!v) throw new HttpError(404, "Version not found");
    tl = v.json as unknown as Timeline;
  } else {
    tl = (o.json as Timeline | undefined) ?? ((await prisma.timeline.findUnique({ where: { projectId: project.id } }))?.json as unknown as Timeline | undefined) ?? null;
  }
  const gate = renderGate(project, tl);
  if (!gate.ok) throw new HttpError(409, gate.reason);
  if (!vid) vid = (await renderVersion(project, o.json)).version.id;
  const render = await prisma.renderJob.create({
    data: { projectId: project.id, userId, versionId: vid, quality: o.quality },
    include: { version: { select: { id: true, name: true, number: true, notes: true } } },
  });
  return { render, changedSinceStills: gate.changed };
}
