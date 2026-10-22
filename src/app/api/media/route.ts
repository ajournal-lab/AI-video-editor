import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/server/db";
import { HttpError, requireUserId, route } from "@/server/http";
import { keyFromUrl } from "@/server/storage";
import { nameTags } from "@/server/tagging";
import { dedupeUpload } from "@/server/medialink";

export const maxDuration = 30;

export const GET = route(async (req: Request) => {
  const userId = await requireUserId();
  const type = new URL(req.url).searchParams.get("type");
  const assets = await prisma.mediaAsset.findMany({
    where: { userId, ...(type ? { type } : {}) },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });
  return { assets };
});

const body = z.object({
  source: z.enum(["upload", "gemini_manual"]).default("upload"),
  type: z.enum(["video", "image", "music", "audio"]),
  url: z.string().min(1).max(2000),
  thumbUrl: z.string().max(2000).nullish(),
  name: z.string().trim().min(1).max(200),
  mime: z.string().max(120).nullish(),
  duration: z.number().nonnegative().nullish(),
  width: z.number().int().positive().nullish(),
  height: z.number().int().positive().nullish(),
  hasAudio: z.boolean().optional(),
  tags: z.array(z.string().trim().toLowerCase().max(40)).max(30).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** Register an uploaded file in the library. Uploads are tagged from their file name. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Invalid media");
  const d = parsed.data;
  const key = keyFromUrl(d.url);
  if (!key || !key.startsWith(`u/${userId}/`)) throw new HttpError(400, "Upload the file first");
  // the same bytes already in the library (sha256): drop the new copy, hand back the existing asset
  const { hash, existing } = await dedupeUpload(userId, key, d.thumbUrl ? keyFromUrl(d.thumbUrl) : null);
  if (existing) return { asset: existing, duplicate: true };
  let tags = d.tags ?? [];
  if (d.source === "gemini_manual") tags = ["gemini", ...tags];
  if (d.source === "upload") {
    tags = [...nameTags(d.name)];
    if (d.type === "music") tags.push("music");
  }
  const asset = await prisma.mediaAsset.create({
    data: {
      userId,
      type: d.type,
      source: d.source,
      key,
      url: d.url,
      thumbUrl: d.thumbUrl ?? null,
      name: d.name,
      mime: d.mime ?? null,
      duration: d.duration ?? null,
      width: d.width ?? null,
      height: d.height ?? null,
      hash,
      tags: [...new Set(tags)].slice(0, 20),
      meta: { ...(d.meta ?? {}), hasAudio: d.hasAudio ?? d.type !== "image" } as Prisma.InputJsonValue,
    },
  });
  return { asset, duplicate: false };
});
