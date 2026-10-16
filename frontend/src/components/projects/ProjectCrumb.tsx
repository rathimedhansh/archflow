"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Project } from "@/lib/api";

/** Loads the property a floor plan belongs to (if any). Failures just mean "no project context". */
export function useProjectOf(projectId: string | null | undefined): Project | null {
  const [project, setProject] = useState<Project | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api.getProject(projectId).then((p) => !cancelled && setProject(p), () => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return projectId ? project : null;
}

/** "Projects / <property>" above a plan's editor or viewer; the old step label for plans without a project. */
export default function ProjectCrumb({ project, fallback, current }: { project: Project | null; fallback: string; current: string }) {
  if (!project) return <p className="eyebrow">{fallback}</p>;
  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted" data-testid="project-crumb">
      <Link href="/projects" className="hover:text-foreground">Properties</Link>
      <span aria-hidden>/</span>
      <Link href={`/projects/${project.id}`} className="max-w-[24ch] truncate hover:text-foreground sm:max-w-none">{project.name}</Link>
      <span aria-hidden>/</span>
      <span className="text-foreground/80" aria-current="page">{current}</span>
    </nav>
  );
}
