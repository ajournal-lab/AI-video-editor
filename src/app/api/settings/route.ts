import { requireUserId, route } from "@/server/http";
import { getSettings, saveSettings } from "@/server/settings";

/** The signed-in user's settings (brand kit, cloud render) + what .env provides (never the secrets). */
export const GET = route(async () => {
  const userId = await requireUserId();
  return {
    settings: await getSettings(userId),
    env: {
      cloud: { tokenSet: Boolean(process.env.CLOUD_RENDER_TOKEN) },
    },
  };
});

export const PUT = route(async (req: Request) => {
  const userId = await requireUserId();
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  return { settings: await saveSettings(userId, body ?? {}) };
});
