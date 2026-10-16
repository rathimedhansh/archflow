import Link from "next/link";
import SiteHeader from "@/components/SiteHeader";
import { PlanToModelIllustration } from "@/components/illustrations";
import { button, pageWidth } from "@/components/ui";
import { ArrowRightIcon } from "@/components/viewer/icons";

const PIPELINE = [
  { step: "1", title: "Upload the plan", body: "Create a property and add its 2D floor plan, a PNG or JPG drawing." },
  { step: "2", title: "Review what was found", body: "Walls, rooms, doors and windows are detected for you. Correct anything that's off and set the real scale." },
  { step: "3", title: "Explore it in 3D", body: "Walk around the model, look from above, fly into each room, or present it as a guided tour." },
  { step: "4", title: "Share with buyers", body: "Publish a read-only 3D page and send the link. Buyers need no account." },
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        <section className={`${pageWidth} grid items-center gap-12 pb-16 pt-14 sm:pt-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:gap-16 lg:pb-24`}>
          <div>
            <p className="eyebrow">From floor plan to walkthrough</p>
            <h1 className="mt-5 max-w-xl font-display text-[2.6rem] font-medium leading-[1.06] tracking-[-0.015em] sm:text-[3.4rem]">
              Making property plans something people can actually <em className="font-normal text-accent">experience.</em>
            </h1>
            <p className="mt-6 max-w-lg text-[17px] leading-relaxed text-muted">
              ARCHFLOW turns flat architectural floor plans into interactive 3D properties, so buyers can explore a home
              before it is built.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Link href="/projects/new" className={button("primary", "lg")}>
                Create a property <ArrowRightIcon />
              </Link>
              <Link href="/projects" className={button("secondary", "lg")}>Your properties</Link>
            </div>
          </div>
          <PlanToModelIllustration className="w-full max-w-[600px] justify-self-center" />
        </section>

        <section className="border-t border-border bg-surface/60" aria-labelledby="how-it-works">
          <div className={`${pageWidth} py-16 sm:py-20`}>
            <h2 id="how-it-works" className="font-display text-[1.75rem] font-medium tracking-[-0.01em]">How it works</h2>
            <ol className="mt-10 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
              {PIPELINE.map((p) => (
                <li key={p.step} className="border-t border-border-strong pt-5">
                  <span className="font-display text-[1.6rem] italic leading-none text-accent">{p.step}</span>
                  <h3 className="mt-3 font-semibold">{p.title}</h3>
                  <p className="mt-2 text-[15px] leading-relaxed text-muted">{p.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className={`${pageWidth} flex flex-wrap items-center justify-between gap-3 py-6 text-[13px] text-muted`}>
          <span>ARCHFLOW · 2D floor plans to interactive 3D property tours</span>
          <Link href="/projects" className="hover:text-foreground">Your properties</Link>
        </div>
      </footer>
    </div>
  );
}
