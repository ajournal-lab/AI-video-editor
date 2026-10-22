import { z } from "zod";
import { HttpError, requireUserId, route } from "@/server/http";
import { importMediaLink } from "@/server/medialink";

export const maxDuration = 1800; // a 30-minute video can take a while to download

// "Paste a link" in the media library and the new-edit drop zones: YouTube / Shorts, TikTok, Instagram reels, Vimeo,
// X posts, Google Drive files or any direct media URL. Returns the asset (or the existing one: duplicate = true).
const body = z.object({ url: z.string().trim().min(4).max(4000) });

export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Paste a link");
  return importMediaLink(userId, parsed.data.url);
});
