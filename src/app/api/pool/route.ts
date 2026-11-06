import { prisma } from "@/server/db";
import { requireUserId, route } from "@/server/http";

const ONLINE_MS = 45_000;

/** Render pool: the PCs running a worker (heartbeat in worker/pool.py) and how much work is waiting. */
export const GET = route(async () => {
  await requireUserId();
  const [nodes, renders, voices, inserts] = await Promise.all([
    prisma.poolNode.findMany({ orderBy: { lastSeen: "desc" }, take: 50 }),
    prisma.renderJob.count({ where: { status: "queued" } }),
    prisma.voiceTrack.count({ where: { status: "queued" } }),
    prisma.insertJob.count({ where: { status: "queued" } }),
  ]);
  const now = Date.now();
  return {
    nodes: nodes.map((n) => ({ ...n, online: now - n.lastSeen.getTime() < ONLINE_MS })),
    queued: { renders, voices, inserts },
  };
});
