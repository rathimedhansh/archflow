import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import { EmptyPlanSketch } from "@/components/illustrations";
import { button, pageWidth } from "@/components/ui";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className={`${pageWidth} flex flex-1 flex-col items-center justify-center pb-24 pt-12 text-center`}>
        <EmptyPlanSketch className="w-52" />
        <p className="eyebrow mt-8">Page not found</p>
        <h1 className="mt-3 font-display text-[2rem] font-medium leading-tight sm:text-[2.4rem]">There&apos;s no room here</h1>
        <p className="mt-3 max-w-md text-[15px] leading-relaxed text-muted">The link may be incomplete, or the page has moved.</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/projects" className={button("primary")}>Your properties</Link>
          <Link href="/" className={button("secondary")}>Home</Link>
        </div>
      </main>
    </div>
  );
}
