// The three built-in looks (rules.md "Looks"). What each one changes is made by applyLooks (looks.ts); the
// caption style and the punch colour are read by derive.ts / draw.ts and mirrored in worker/timeline.py + ass.py.
import type { CaptionStyle, GradeLook, LookId } from "./types";

export const PUNCH_COLOR = "#FFD60A";

export interface LookDef {
  label: string;
  blurb: string;
  captions: CaptionStyle;
  grade: { look: GradeLook; intensity: number } | null; // the main clips
  subjectGrade: { look: GradeLook; intensity: number } | null; // the speaker on the Cut-out track
  cutout: boolean; // needs the speaker cut out (words / reels behind them, or the speaker lit apart from the room)
  swatch: string; // timeline lane colour
}

export const LOOKS: Record<LookId, LookDef> = {
  bold: {
    label: "Bold",
    blurb: "Kinetic lowercase words around you, big words behind your head (cut-out), the punch word in yellow.",
    captions: "kinetic",
    grade: null,
    subjectGrade: null,
    cutout: true,
    swatch: "#f59e0b",
  },
  cool_girl: {
    label: "Cool girl",
    blurb: "Warm grade, calm lowercase text, one punch line in a yellow serif italic with sparkles, your own reels orbiting you.",
    captions: "calm",
    grade: { look: "warm_soft", intensity: 0.8 },
    subjectGrade: { look: "warm_soft", intensity: 0.8 },
    cutout: true,
    swatch: "#f472b6",
  },
  cool_dude: {
    label: "Cool dude",
    blurb: "Dark editorial grade (the room falls back, you stay lit), tiny spaced capitals + big serif words, wide / close-up crops like a studio interview.",
    captions: "editorial",
    grade: { look: "dark_editorial", intensity: 0.85 },
    subjectGrade: { look: "editorial_subject", intensity: 0.8 },
    cutout: true,
    swatch: "#38bdf8",
  },
};

export const LOOK_IDS = Object.keys(LOOKS) as LookId[];

/** "cool girl", "Cool-Girl", "coolgirl aesthetic" -> "cool_girl". */
export function parseLookName(s: string): LookId | null {
  const v = s.toLowerCase().replace(/[^a-z]/g, "");
  if (/^(bold|boldlook|boldstyle|boldaesthetic)$/.test(v)) return "bold";
  if (/^(coolgirl|coolgirlaesthetic|coolgirllook|coolgirlstyle|thatgirl)$/.test(v)) return "cool_girl";
  if (/^(cooldude|coolguy|cooldudeaesthetic|cooldudelook|cooldudestyle|coolguylook|editorial)$/.test(v)) return "cool_dude";
  return null;
}
