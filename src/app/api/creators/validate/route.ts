import { z } from "zod";
import { HttpError, requireUserId, route } from "@/server/http";
import { checkLink } from "@/server/creators";

/** Live check of one link on the New creator profile form: supported site, public, reachable (yt-dlp metadata only). */
export const POST = route(async (req: Request) => {
  await requireUserId();
  const parsed = z.object({ url: z.string().max(500) }).safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Missing url");
  return checkLink(parsed.data.url);
});
