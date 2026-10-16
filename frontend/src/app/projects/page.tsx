"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import SiteHeader from "@/components/SiteHeader";
import { EmptyPlanSketch } from "@/components/illustrations";
import { StageBadge } from "@/components/projects/ui";
import { button, Notice, PageHeader, pageWidth, Skeleton } from "@/components/ui";
import { PlusIcon } from "@/components/viewer/icons";
import { absoluteUrl, api, ApiError, type Project } from "@/lib/api";
import { timeAgo } from "@/lib/projects/status";

type Loaded = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; projects: Project[] };

function ProjectCard({ p }: { p: Project }) {
  const plan = p.plan;
  const facts = plan?.saved && !plan.damaged
    ? [`${plan.rooms} room${plan.rooms === 1 ? "" : "s"}`, `${plan.calibrated ? "" : "≈ "}${plan.floor_area_m2.toFixed(1)} m²`]
    : [p.floorplan ? "Plan not saved yet" : "No floor plan yet"];
  return (
    <li>
      <Link href={`/projects/${p.id}`} data-testid="project-card"
        className="group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-surface transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
        <div className="drafting-paper relative flex aspect-[4/3] items-center justify-center overflow-hidden border-b border-border">
          {p.floorplan ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={absoluteUrl(p.floorplan.image_url)} alt="" loading="lazy"
              className="h-full w-full object-contain p-6 mix-blend-multiply transition-transform duration-300 group-hover:scale-[1.02]" />
          ) : (
            <EmptyPlanSketch className="w-1/2 opacity-80" />
          )}
          <div className="absolute left-3 top-3"><StageBadge project={p} /></div>
        </div>
        <div className="flex flex-1 flex-col px-5 pb-4 pt-4">
          <h2 className="font-display text-[1.3rem] font-medium leading-snug tracking-[-0.005em]">{p.name}</h2>
          <p className="mt-1 text-sm text-muted">{p.address || <span className="italic opacity-80">No address added</span>}</p>
          <div className="mt-auto pt-4">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border pt-3 text-[13px] text-muted">
              <span className="tabular-nums text-foreground/80">{facts.join(" · ")}</span>
              <span>Updated {timeAgo(p.updated_at > (plan?.saved_at ?? "") ? p.updated_at : plan?.saved_at)}</span>
            </div>
          </div>
        </div>
      </Link>
    </li>
  );
}

function NewPropertyTile() {
  return (
    <li>
      <Link href="/projects/new"
        className="group flex h-full min-h-56 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-strong px-6 text-center text-muted transition-colors hover:border-accent/60 hover:bg-surface/70 hover:text-foreground">
        <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border-strong bg-surface text-accent transition-colors group-hover:border-accent/50">
          <PlusIcon />
        </span>
        <span className="font-medium">Add a property</span>
        <span className="max-w-[16rem] text-[13px]">Start with a name, then upload its floor plan.</span>
      </Link>
    </li>
  );
}

export default function ProjectsPage() {
  const [state, setState] = useState<Loaded>({ kind: "loading" });

  const fetchProjects = useCallback(() => api.listProjects()
    .then((projects) => setState({ kind: "ready", projects }))
    .catch((err) => setState({ kind: "error", message: err instanceof ApiError ? err.message : "Your properties could not be loaded." })), []);
  useEffect(() => {
    document.title = "Properties · ARCHFLOW";
    void fetchProjects();
  }, [fetchProjects]);
  const retry = () => {
    setState({ kind: "loading" });
    void fetchProjects();
  };

  const count = state.kind === "ready" ? state.projects.length : null;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className={`${pageWidth} flex-1 pb-20 pt-10 sm:pt-14`}>
        <PageHeader
          title="Your properties"
          lead={count ? `${count} propert${count === 1 ? "y" : "ies"}, from first upload to the page buyers see.` : "Each property holds its floor plan, its 3D model and the page you share with buyers."}
          actions={<Link href="/projects/new" className={button("primary")}><PlusIcon /> New property</Link>}
        />

        <div className="mt-10">
          {state.kind === "loading" && (
            <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Loading properties">
              {[0, 1, 2].map((i) => (
                <li key={i} className="overflow-hidden rounded-xl border border-border bg-surface">
                  <Skeleton className="aspect-[4/3] rounded-none" />
                  <div className="space-y-2.5 p-5"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-4 w-1/2" /></div>
                </li>
              ))}
            </ul>
          )}
          {state.kind === "error" && (
            <Notice tone="danger" title="We couldn't load your properties" className="max-w-2xl"
              action={<button type="button" onClick={retry} className={button("secondary", "sm")}>Try again</button>}>
              {state.message} Check that the ARCHFLOW engine is running.
            </Notice>
          )}
          {state.kind === "ready" && state.projects.length === 0 && (
            <div className="flex flex-col items-center rounded-xl border border-dashed border-border-strong px-6 py-16 text-center" data-testid="projects-empty">
              <EmptyPlanSketch className="w-56" />
              <h2 className="mt-8 font-display text-[1.6rem] font-medium">Your first property starts with a floor plan</h2>
              <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-muted">
                Name the property, upload its 2D plan, and ARCHFLOW builds a 3D model you can explore and share with buyers.
              </p>
              <Link href="/projects/new" className={`${button("primary")} mt-7`}>Create your first property</Link>
            </div>
          )}
          {state.kind === "ready" && state.projects.length > 0 && (
            <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3" data-testid="project-list">
              {state.projects.map((p) => <ProjectCard key={p.id} p={p} />)}
              <NewPropertyTile />
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}
