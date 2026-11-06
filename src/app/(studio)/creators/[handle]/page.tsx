import { CreatorDetail } from "@/components/creators/CreatorDetail";

export const metadata = { title: "Creator · AJOURNALLAB Studio" };

export default async function Page({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  return <CreatorDetail handle={decodeURIComponent(handle)} />;
}
