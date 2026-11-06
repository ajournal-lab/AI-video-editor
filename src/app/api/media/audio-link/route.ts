import { z } from "zod";
import { HttpError, requireUserId, route } from "@/server/http";
import { createLinkAsset } from "@/server/audiolink";

export const maxDuration = 300; // Vercel Hobby limit (no limit on a local install)

// Music/Audio panel → "Paste link": Instagram /reel/, YouTube / Shorts or a direct audio file URL.
// Downloads with yt-dlp (or a guarded fetch), converts to a 48 kHz WAV and stores the beat grid, drop and
// loudness in meta. Link-sourced audio is "timing only / personal use" (meta.rights = false) until the user ticks
// "I have the rights" (PATCH /api/media/:id { rights }).

const body = z.object({ url: z.string().trim().min(4).max(4000) });

export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Paste a link");
  return { asset: await createLinkAsset(userId, parsed.data.url) };
});
