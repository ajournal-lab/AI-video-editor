import Link from "next/link";
import { LogOut, Plus } from "lucide-react";
import { signOut } from "@/auth";
import { Button } from "@/components/ui/button";
import { GeminiNav } from "./GeminiNav";
import { Logo } from "./Logo";

export function AppHeader({ email }: { email?: string | null }) {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-2 px-3 sm:gap-3 sm:px-6">
        <Logo href="/dashboard" />
        <nav className="flex items-center text-sm sm:ml-2 sm:gap-1">
          <Link href="/dashboard" className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:px-2.5">
            Projects
          </Link>
          <Link href="/media" className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:px-2.5">
            Media
          </Link>
          <Link href="/jobs" className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:px-2.5">
            Jobs
          </Link>
          <Link href="/creators" className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:px-2.5">
            Creators
          </Link>
          <Link href="/rules" className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:px-2.5">
            Rules
          </Link>
          <Link href="/gotchas" className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:px-2.5">
            Gotchas
          </Link>
          <Link href="/settings" className="rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:px-2.5">
            Settings
          </Link>
          <GeminiNav />
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" asChild className="hidden sm:inline-flex">
            <Link href="/projects/new">
              <Plus /> New video
            </Link>
          </Button>
          <span className="hidden max-w-48 truncate text-xs text-muted-foreground md:block">{email}</span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/" });
            }}
          >
            <Button variant="ghost" size="icon" type="submit" aria-label="Sign out" title="Sign out">
              <LogOut />
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
