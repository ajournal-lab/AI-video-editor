import Link from "next/link";
import { BRAND } from "@/lib/brand";

export function Logo({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="brand-gradient flex size-7 items-center justify-center rounded-lg text-white shadow-lg shadow-primary/30">
        <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden>
          <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
          <rect x="3" y="6" width="2.4" height="12" rx="1.2" />
        </svg>
      </span>
      {BRAND}
    </Link>
  );
}
