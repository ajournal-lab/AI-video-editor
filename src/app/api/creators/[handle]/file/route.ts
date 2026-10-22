import { readFile } from "node:fs/promises";
import { requireUserId, route, type Ctx } from "@/server/http";
import { creatorFile } from "@/server/creators";

export const dynamic = "force-dynamic";

/** ?path=sheets/<id>_hook.jpg | videos/<id>.mp4 | transcripts/<id>.json | teardown.md (inside the profile folder only). */
export const GET = route(async (req: Request, ctx: Ctx<{ handle: string }>) => {
  await requireUserId();
  const { handle } = await ctx.params;
  const f = creatorFile(decodeURIComponent(handle), new URL(req.url).searchParams.get("path") ?? "");
  return new Response(new Uint8Array(await readFile(f.path)), { headers: { "Content-Type": f.type, "Cache-Control": "private, max-age=300" } });
});
