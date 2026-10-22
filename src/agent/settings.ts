// Per-user settings (User.settings JSON), shared by the Next.js server and the agent runner.
// Everything has a safe default: no brand kit, cloud render OFF. (AI always runs on the Claude subscription.)
import { z } from "zod";


const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A client's brand kit: sits between the user's taste rules and a creator's style.json (rules.md "Style priority"). */
export const brandKitSchema = z.object({
  enabled: z.boolean().default(true),
  name: z.string().max(80).default(""),
  font: z.enum(["inter", "montserrat", "bebas", "playfair", "marker"]).nullish(),
  primary: hex.nullish(), // caption / title colour
  accent: hex.nullish(), // highlighted word / accent text
  captionStyle: z.enum(["bold", "karaoke", "minimal", "boxed"]).nullish(),
  uppercase: z.boolean().nullish(),
  notes: z.string().max(2000).default(""), // free text: logo placement, banned words, tone...
  look: z.enum(["bold", "cool_girl", "cool_dude"]).nullish(), // the client's default look for new edits
  handle: z.string().max(60).nullish(), // the client's @handle (Follow CTA insert)
});
export type BrandKit = z.infer<typeof brandKitSchema>;

export const settingsSchema = z.object({
  brandKit: brandKitSchema.nullish(),
  // the phone page /m/<token>: your latest phone previews, no login (anyone with the link on your network can watch)
  phoneToken: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).nullish(),
  cloud: z
    .object({
      enabled: z.boolean().default(false), // master switch; even when on, every run needs a click + confirmation
      repo: z.string().max(140).default(""), // owner/name of an existing PRIVATE repo
      keep: z.boolean().default(false), // keep uploaded media + artifact after download
    })
    .default({ enabled: false, repo: "", keep: false }),
});
export type UserSettings = z.infer<typeof settingsSchema>;

export function readSettings(raw: unknown): UserSettings {
  const r = settingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : settingsSchema.parse({});
}
