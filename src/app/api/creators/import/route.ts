import { HttpError, requireUserId, route } from "@/server/http";
import { importCreator } from "@/server/creators";

/** Import a profile zip (multipart: file, optional handle). */
export const POST = route(async (req: Request) => {
  const userId = await requireUserId();
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") throw new HttpError(400, "Choose a .zip file");
  if (file.size > 10 * 1024 * 1024) throw new HttpError(400, "The zip is too large");
  const handle = form?.get("handle");
  return importCreator(userId, Buffer.from(await file.arrayBuffer()), typeof handle === "string" && handle.trim() ? handle.trim() : null);
});
