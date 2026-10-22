import { z } from "zod";
import QRCode from "qrcode";
import { requireUserId, route } from "@/server/http";
import { lanAddresses, phoneToken } from "@/server/phone";

/** The phone link (LAN address + token) and its QR code. POST { reset: true } makes a new token (old links stop). */
async function info(req: Request, reset: boolean) {
  const userId = await requireUserId();
  const token = await phoneToken(userId, reset);
  const u = new URL(req.url);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  const lan = lanAddresses();
  const base = lan.length ? `${u.protocol}//${lan[0].address}${["80", "443"].includes(port) ? "" : `:${port}`}` : u.origin;
  const url = `${base}/m/${token}`;
  const qr = await QRCode.toString(url, { type: "svg", margin: 1, width: 220, color: { dark: "#000000", light: "#ffffff" } });
  return { url, qr, lan, local: `${u.origin}/m/${token}` };
}

export const GET = route(async (req: Request) => info(req, false));
export const POST = route(async (req: Request) => {
  const body = z.object({ reset: z.boolean().default(false) }).safeParse(await req.json().catch(() => ({})));
  return info(req, body.success ? body.data.reset : false);
});
