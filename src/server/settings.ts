import "server-only";
import type { Prisma } from "@prisma/client";
import { readSettings, settingsSchema, type UserSettings } from "@/agent/settings";
import { prisma } from "./db";
import { HttpError } from "./http";

export async function getSettings(userId: string): Promise<UserSettings> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { settings: true } });
  return readSettings(u?.settings);
}

/** Merge a partial update into the user's settings (validated as a whole). */
export async function saveSettings(userId: string, patch: Record<string, unknown>): Promise<UserSettings> {
  const cur = await getSettings(userId);
  const merged = {
    ...cur,
    ...patch,
    cloud: { ...cur.cloud, ...((patch.cloud as object | undefined) ?? {}) },
    brandKit: patch.brandKit === null ? null : patch.brandKit !== undefined ? { ...(cur.brandKit ?? {}), ...(patch.brandKit as object) } : cur.brandKit,
  };
  const r = settingsSchema.safeParse(merged);
  if (!r.success) throw new HttpError(400, `Invalid settings: ${r.error.issues[0]?.path.join(".")} ${r.error.issues[0]?.message}`);
  if (r.data.cloud.repo && !/^[\w.-]+\/[\w.-]+$/.test(r.data.cloud.repo)) throw new HttpError(400, "Cloud repo must look like owner/name");
  await prisma.user.update({ where: { id: userId }, data: { settings: r.data as unknown as Prisma.InputJsonValue } });
  return r.data;
}
