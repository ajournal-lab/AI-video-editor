import "server-only";
import type { MediaAsset } from "@prisma/client";
import { describeForAi, type AiOp, type ResolvedVisual } from "@/lib/timeline/ai";
import { findClip } from "@/lib/timeline/derive";
import type { Timeline, VisualClip } from "@/lib/timeline/types";
import type { AiEditResult } from "@/agent/schemas";
import { prisma } from "./db";
import { pickVisual } from "./visuals";

// AI edit commands run as a headless Claude job (kind "ai_edit"): Claude reads the
// timeline summary and writes ai-edit.json ({summary, ops}); the browser applies the
// ops with applyAiOps() and shows a diff preview before the user applies them.

export const AI_EDIT_OPS = `You edit short videos by emitting operations on a timeline. Times are seconds.
Operations (only use the fields each needs):
- cut_pauses {minGap?}: remove pauses between spoken words longer than minGap (default 0.7) from the whole video.
- set_filters {clipIds, brightness?, contrast?, saturation?, preset?}: multipliers where 1 = unchanged (brightness/contrast 0.5-1.5, saturation 0-2). preset: none|warm|cool|bw. "Moodier" = contrast up ~1.2, saturation down ~0.75, brightness ~0.9, often cool. "Warmer/cozier" = warm preset.
- set_clip {clipIds, speed?, volume?, muted?, fadeIn?, fadeOut?, kenBurns?, transition?, transitionDuration?}: transition is how a clip enters from the previous one (cut|crossfade|slide|zoom|flash; flash = white flash, good on a drop).
- replace_visual {clipIds, query}: swap the visuals of clips for another clip from the user's media library, matched by tags and file name. query = a few concrete words (e.g. "squat gym mirror").
- add_text {text, start, duration?, textPreset?, color?, size?, font?, y?, animIn?, animOut?}: always set textPreset: title (big title card), lower-third (name/tip bar near the bottom) or headline (mid-screen statement). A "title card at start" = add_text with textPreset title at start 0. add_text always needs text: use the user's words, or write a short (2-6 word) line that fits what is said at that moment — never placeholder text.
- update_text {clipIds, text?, color?, size?, font?, y?, animIn?, animOut?}
- delete_clips {clipIds}
- set_captions {enabled?, captionStyle?, y?, size?}: captionStyle bold|karaoke|minimal|boxed (kinetic|calm|editorial are the looks' captions:
  prefer set_looks for those).
- set_music {volume?, duck?, duckLevel?}
- move_clip {clipIds:[id], start}; trim_clip {clipIds:[id], start?, end?}; split {time, clipIds?}; remove_range {start, end}.
- zoom {scale, clipIds | start+end, x?, y?}: punch-in (scale 1-1.5 of the clip's framing; 1 = back to normal), capped at the clip's
  maxZoom (its source resolution). With start/end (timeline seconds) ReelSmith splits the video at both ends and zooms the part
  in between, so you don't need clip ids. "Punchy zooms" on a talking head = zoom 1.1-1.15 over a phrase with an emphasis word.
- add_fx {fx: punch|shake|flash, time, strength?, duration?}: a quick effect on the whole picture at a moment (punch = zoom bump,
  strength 0.05-0.15; shake 0.01-0.03; flash 0.3-0.8). Use on emphasis words or beats, not continuously. clear_fx {start?, end?, fx?} removes them.
- set_looks {look, default?, phrase?, start?, end?, clear?}: the look presets. look: bold (kinetic lowercase words around the speaker, big
  words behind the head, punch word yellow) | cool_girl (warm grade, calm lowercase text, one yellow serif italic punch line with sparkles,
  the user's reels orbiting) | cool_dude (dark editorial grade, tiny spaced capitals + big serif words, wide/close-up crops) | none.
  default: true = the project's look outside sections; phrase = a section for every sentence that says it ("cool girl when I say X");
  start/end = a section by time; clear: true = all looks off. Several ops for "cool girl when I say X, bold everywhere else".
Rules: refer only to clip ids that exist. "Scene N" means visual clips whose scene == N. Use keywords/name/said to find clips
("city clips" = visual clips whose keywords or name mention city/urban/street/buildings). Prefer the fewest ops that do exactly what was asked, and only include the fields an op uses.
If the request is impossible, return no ops and explain in summary. summary is one short sentence describing the change.`;

export function aiEditPrompt(command: string, timelineFile: string) {
  return `Edit request for the video in this project: ${JSON.stringify(command)}

The current timeline (clip ids, times, names, keywords, what is said) is in ${timelineFile}. Read it first.
Answer by writing ai-edit.json as {"summary": string, "ops": Op[]} using only these operations:

${AI_EDIT_OPS}

Do not render anything or touch media files; only decide the operations.`;
}

export const aiEditInput = (tl: Timeline) => describeForAi(tl);

/** Resolve replace_visual ops to concrete library media so the client can preview/apply offline. */
export async function resolveAiEdit(userId: string, tl: Timeline, res: AiEditResult) {
  const ops = res.ops as (AiOp & { why?: string })[];
  let library: MediaAsset[] | null = null;
  const used = new Set<string>();
  for (const o of ops) {
    if (o.op !== "replace_visual" || !o.clipIds?.length) continue;
    library ??= await prisma.mediaAsset.findMany({ where: { userId, type: { in: ["video", "image"] } }, take: 500 });
    o.resolved = {};
    const words = (o.query ?? "").split(/\s+/).filter(Boolean);
    for (const [i, id] of o.clipIds.entries()) {
      const hit = findClip(tl, id);
      if (!hit || hit.clip.type === "text" || hit.clip.type === "audio") continue;
      const clip = hit.clip as VisualClip;
      const a = pickVisual({ library, keywords: words, used, index: i }).asset;
      if (!a) continue;
      const r: ResolvedVisual = {
        type: a.type === "video" ? "video" : "image",
        assetId: a.id,
        src: a.url,
        thumb: a.thumbUrl ?? a.url,
        name: `${clip.scene ? `Scene ${clip.scene} · ` : ""}${o.query}`,
        srcDuration: a.duration,
        srcWidth: a.width,
        srcHeight: a.height,
        hasAudio: ((a.meta ?? {}) as { hasAudio?: boolean }).hasAudio ?? a.type === "video",
        muted: clip.muted,
        keywords: words,
      };
      o.resolved[id] = r;
    }
  }
  const unresolved = ops.some((o) => o.op === "replace_visual" && o.clipIds?.length && !Object.keys(o.resolved ?? {}).length);
  return { summary: unresolved ? `${res.summary} (No matching clip in your library: upload one with a descriptive file name.)` : res.summary, ops };
}
