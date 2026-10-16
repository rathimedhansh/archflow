"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import SiteHeader from "@/components/SiteHeader";
import ProjectForm from "@/components/projects/ProjectForm";
import { Notice, PageHeader, pageWidth, Panel } from "@/components/ui";
import { api, ApiError } from "@/lib/api";

const NEXT = [
  ["Upload the floor plan", "A PNG or JPG of the 2D plan. Clean black-and-white drawings work best."],
  ["Review the detected plan", "Check the walls, rooms, doors and windows, fix anything that's off and set the scale."],
  ["Explore and share", "Walk through the 3D model, then publish a page for buyers."],
] as const;

export default function NewProjectPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = "New property · ARCHFLOW";
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className={`${pageWidth} flex-1 pb-20 pt-8 sm:pt-10`}>
        <nav aria-label="Breadcrumb" className="mb-6 flex items-center gap-2 text-sm text-muted">
          <Link href="/projects" className="hover:text-foreground">Properties</Link>
          <span aria-hidden>/</span>
          <span className="text-foreground/80">New property</span>
        </nav>
        <PageHeader title="Create a property" lead="Give it a name. Next, you'll upload its floor plan, review it, and publish an interactive 3D page for buyers." />

        <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,36rem)_minmax(0,1fr)] lg:gap-16">
          <Panel>
            <ProjectForm
              submitLabel="Create property"
              busy={busy}
              onCancel={() => router.push("/projects")}
              onSubmit={async (fields) => {
                setBusy(true);
                setError(null);
                try {
                  const project = await api.createProject(fields);
                  router.push(`/projects/${project.id}`);
                } catch (err) {
                  setBusy(false);
                  setError(err instanceof ApiError ? err.message : "The property could not be created.");
                }
              }}
            />
            {error && <Notice tone="danger" className="mt-6" title="That didn't work">{error}</Notice>}
          </Panel>

          <aside aria-labelledby="what-next" className="lg:pt-2">
            <h2 id="what-next" className="eyebrow">What happens next</h2>
            <ol className="mt-5 space-y-6">
              {NEXT.map(([title, body], i) => (
                <li key={title} className="flex gap-4">
                  <span className="font-display text-xl italic leading-6 text-accent">{i + 1}</span>
                  <span>
                    <span className="block font-medium">{title}</span>
                    <span className="mt-1 block text-sm leading-relaxed text-muted">{body}</span>
                  </span>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      </main>
    </div>
  );
}
