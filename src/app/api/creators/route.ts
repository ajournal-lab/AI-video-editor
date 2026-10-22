import { z } from "zod";
import { HttpError, requireUserId, route } from "@/server/http";
import { listCreators, startTeardown } from "@/server/creators";

/** Creator profiles (finished teardowns and running ones). */
export const GET = route(async () => {
  await requireUserId();
  return { creators: await listCreators() };
});

const body = z.object({
  handle: z.string().trim().min(1).max(61),
  platform: z.enum(["tiktok", "youtube"]).nullish(),
  urls: z.array(z.string().trim().url()).max(5).nullish(), // exactly 5 public video links, or none = the latest 5
  notes: z.string().max(2000).optional(),
  projectId: z.string().nullish(),
});

/** Start a teardown: download + measure 5 videos (local), then Claude writes style.json + teardown.md. */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? "Invalid request");
  return startTeardown({ userId, ...parsed.data });
});
