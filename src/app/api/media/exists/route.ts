import { z } from "zod";
import { HttpError, requireUserId, route } from "@/server/http";
import { findByHash } from "@/server/medialink";

// Before an upload: is a file with this sha256 already in the library? (The browser hashes the file; the server checks
// again after the upload, so this is only to skip uploading a known file.)
const body = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/) });

export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw new HttpError(400, "Invalid hash");
  return { asset: await findByHash(userId, parsed.data.hash) };
});
