"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import AccountButton from "@/components/AccountButton";
import ApiStatus from "@/components/ApiStatus";
import Logo from "@/components/Logo";
import { pageWidth } from "@/components/ui";

/** App header: wordmark, the properties link, sign-out (when signed in) and a quiet engine status. */
export default function SiteHeader() {
  const path = usePathname();
  const inProperties = path.startsWith("/projects") || path.startsWith("/plans");
  return (
    <header className="relative z-10 border-b border-border/70 bg-background/85 backdrop-blur-sm">
      <div className={`${pageWidth} flex h-16 items-center justify-between gap-4`}>
        <Link href="/" aria-label="ARCHFLOW home" className="rounded-md">
          <Logo />
        </Link>
        <nav className="flex items-center gap-1 text-sm sm:gap-3" aria-label="Main">
          <Link
            href="/projects"
            aria-current={inProperties ? "page" : undefined}
            className={`rounded-md px-3 py-2 font-medium transition-colors ${inProperties ? "text-foreground" : "text-muted hover:text-foreground"}`}
          >
            Properties
          </Link>
          <AccountButton />
          <ApiStatus />
        </nav>
      </div>
    </header>
  );
}
