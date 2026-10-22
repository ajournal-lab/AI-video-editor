import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { HttpError, ownedProject, requireUserId, route, type Ctx } from "@/server/http";
import { ensureProjectDir } from "@/server/agent";

export const dynamic = "force-dynamic";

/** ?file=edit/stills/<job>/still_00.jpg: a key still (stage 2), only from the project's stills folder. */
export const GET = route(async (req: Request, ctx: Ctx<{ id: string }>) => {
  const userId = await requireUserId();
  const { id } = await ctx.params;
  await ownedProject(id, userId);
  const dir = ensureProjectDir(id);
  const root = path.join(dir, "edit", "stills");
  const p = path.resolve(dir, new URL(req.url).searchParams.get("file") ?? "");
  if (!p.startsWith(root + path.sep) || !p.endsWith(".jpg") || !existsSync(p)) throw new HttpError(404, "Still not found");
  return new Response(new Uint8Array(await readFile(p)), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" } });
});
