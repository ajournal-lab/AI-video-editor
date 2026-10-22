import type { FontId } from "./types";

// Every font ships as a TTF in public/fonts, loaded by the browser via @font-face
// (see globals.css) and by libass in the worker via fontsdir, so preview and render
// draw the same glyphs. asc/desc are OS/2 usWinAscent/usWinDescent over unitsPerEm:
// libass sizes fonts so that (asc + desc) == ASS font size, and puts line boxes at
// that height, so ass_size = px * (asc + desc).
export const FONTS: Record<
  FontId,
  { label: string; css: string; ass: string; bold: boolean; italic?: boolean; asc: number; desc: number }
> = {
  inter: { label: "Inter", css: "RS Inter", ass: "Inter ExtraBold", bold: false, asc: 1.1079, desc: 0.3223 },
  montserrat: { label: "Montserrat", css: "RS Montserrat", ass: "Montserrat Thin ExtraBold", bold: false, asc: 1.109, desc: 0.453 },
  bebas: { label: "Bebas Neue", css: "RS Bebas", ass: "Bebas Neue", bold: false, asc: 0.95, desc: 0.35 },
  playfair: { label: "Playfair", css: "RS Playfair", ass: "Playfair Display", bold: true, asc: 1.159, desc: 0.251 },
  "playfair-italic": { label: "Playfair Italic", css: "RS Playfair Italic", ass: "Playfair Display", bold: false, italic: true, asc: 1.159, desc: 0.251 },
  marker: { label: "Marker", css: "RS Marker", ass: "Permanent Marker", bold: false, asc: 1.1094, desc: 0.3174 },
};

export const FONT_IDS = Object.keys(FONTS) as FontId[];

export function cssFont(font: FontId, px: number) {
  return `${px}px "${FONTS[font].css}"`;
}
