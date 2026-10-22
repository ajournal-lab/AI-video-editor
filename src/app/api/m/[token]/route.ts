import { NextResponse } from "next/server";
import { phoneFeed } from "@/server/phone";

/** Public (token only): the user's latest phone previews, for the /m/<token> page. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const feed = await phoneFeed(token);
  if (!feed) return NextResponse.json({ error: "Link not found" }, { status: 404 });
  return NextResponse.json({ renders: feed }, { headers: { "Cache-Control": "no-store" } });
}
