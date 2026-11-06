import type { Metadata } from "next";
import { PhoneFeed } from "./PhoneFeed";

export const metadata: Metadata = { title: "AJOURNALLAB Studio previews", robots: { index: false, follow: false } };

/** Phone review page (no login, the token is the key): your latest phone previews, newest first. */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PhoneFeed token={token} />;
}
