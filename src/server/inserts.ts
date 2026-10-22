import "server-only";
// Insert jobs (rules.md "Inserts"): one InsertJob per (project, spec hash), built by the worker's insert pool in parallel
// with renders. The editor queues them as soon as an insert is placed; a render snapshot carries the built files.
import type { Prisma } from "@prisma/client";
import { insertSpecs, specHash, withInsertSrc, type InsertStatus } from "@/lib/timeline/inserts";
import type { InsertSpec, Timeline } from "@/lib/timeline/types";
import { prisma } from "./db";
import { HttpError } from "./http";

const dto = (r: { hash: string; kind: string; status: string; progress: number; outputUrl: string | null; frontUrl: string | null; error: string | null; note: string | null }): InsertStatus => ({
  hash: r.hash,
  kind: r.kind as InsertStatus["kind"],
  status: r.status as InsertStatus["status"],
  progress: r.progress,
  outputUrl: r.outputUrl,
  frontUrl: r.frontUrl,
  error: r.error,
  note: r.note,
});

/** Queue the specs that aren't built or building yet (failed ones are retried). Returns every status. */
export async function queueInserts(projectId: string, userId: string, specs: InsertSpec[]) {
  for (const spec of specs) {
    if (spec.kind !== "follow_cta" && spec.kind !== "orbit" && !spec.src) throw new HttpError(400, `${spec.kind}: pick a screenshot or video first`);
    if (spec.kind === "orbit" && !spec.sources?.length) throw new HttpError(400, "Pick at least one reel to orbit");
    const hash = specHash(spec);
    const cur = await prisma.insertJob.findUnique({ where: { projectId_hash: { projectId, hash } } });
    if (!cur) {
      await prisma.insertJob.create({ data: { projectId, userId, hash, kind: spec.kind, spec: spec as unknown as Prisma.InputJsonValue } });
    } else if (cur.status === "failed") {
      await prisma.insertJob.update({ where: { id: cur.id }, data: { status: "queued", attempts: 0, error: null, progress: 0 } });
    }
  }
  return listInserts(projectId);
}

export async function listInserts(projectId: string) {
  const rows = await prisma.insertJob.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } });
  return rows.map(dto);
}

/** For a render snapshot: queue the timeline's inserts and fill in the ones already built. */
export async function resolveInserts(projectId: string, userId: string, tl: Timeline): Promise<Timeline> {
  const specs = insertSpecs(tl);
  if (!specs.length) return tl;
  const list = await queueInserts(projectId, userId, specs.map((s) => s.spec));
  return withInsertSrc(tl, Object.fromEntries(list.map((s) => [s.hash, s])));
}
