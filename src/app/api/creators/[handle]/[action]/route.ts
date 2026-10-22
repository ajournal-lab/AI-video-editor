import { z } from "zod";
import { HttpError, requireUserId, route, type Ctx } from "@/server/http";
import { cancelTeardown, duplicateCreator, exportCreator, readMeta, renameCreator, replaceVideo, resetStyle, saveStyle, startTeardown } from "@/server/creators";
import { normHandle } from "@/server/style";

type P = Ctx<{ handle: string; action: string }>;

const bodies = {
  rerun: z.object({ urls: z.array(z.string().trim()).max(5).nullish(), notes: z.string().max(2000).optional(), platform: z.enum(["tiktok", "youtube"]).nullish() }),
  replace: z.object({ videoId: z.string().default(""), url: z.string().trim().url() }), // videoId "" = add (retry a failed one)
  rename: z.object({ to: z.string().trim().min(1).max(61) }),
  duplicate: z.object({ to: z.string().trim().min(1).max(61) }),
  style: z.object({ style: z.record(z.string(), z.unknown()) }),
};

/**
 * POST /api/creators/<handle>/<action>
 *   rerun {urls?, notes?}   re-analyse (same links, or new ones)      cancel             stop the running teardown
 *   replace {videoId, url}  re-measure one video, then re-analyse     rename {to} · duplicate {to}
 *   style {style}           save the edited style.json                reset              back to the measured style.json
 */
export const POST = route(async (req: Request, ctx: P) => {
  const userId = await requireUserId();
  const { handle: raw, action } = await ctx.params;
  const handle = normHandle(decodeURIComponent(raw));
  const json = await req.json().catch(() => ({}));
  const parse = <K extends keyof typeof bodies>(k: K) => {
    const r = bodies[k].safeParse(json);
    if (!r.success) throw new HttpError(400, r.error.issues[0]?.message ?? "Invalid request");
    return r.data as z.infer<(typeof bodies)[K]>;
  };
  switch (action) {
    case "rerun": {
      const b = parse("rerun");
      const meta = readMeta(handle);
      if (!meta) throw new HttpError(404, "No such profile");
      const urls = b.urls?.filter(Boolean).length ? b.urls.filter(Boolean) : meta.urls;
      return startTeardown({ userId, handle, platform: b.platform ?? meta.platform, urls, notes: b.notes ?? meta.notes });
    }
    case "cancel":
      await cancelTeardown(handle);
      return { ok: true };
    case "replace": {
      const b = parse("replace");
      return replaceVideo({ userId, handle, videoId: b.videoId, url: b.url });
    }
    case "rename":
      return renameCreator(userId, handle, parse("rename").to);
    case "duplicate":
      return duplicateCreator(handle, parse("duplicate").to);
    case "style":
      return { style: saveStyle(handle, parse("style").style) };
    case "reset":
      return { style: resetStyle(handle) };
    default:
      throw new HttpError(404, "Unknown action");
  }
});

/** GET /api/creators/<handle>/export -> <handle>-style.zip (teardown.md + style.json) */
export const GET = route(async (_req: Request, ctx: P) => {
  await requireUserId();
  const { handle: raw, action } = await ctx.params;
  if (action !== "export") throw new HttpError(404, "Unknown action");
  const handle = normHandle(decodeURIComponent(raw));
  const zip = exportCreator(handle);
  return new Response(new Uint8Array(zip), {
    headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${handle}-style.zip"` },
  });
});
