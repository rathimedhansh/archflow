"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import SiteHeader from "@/components/SiteHeader";
import { button, PageHeader, pageWidth, Spinner } from "@/components/ui";
import { LinkIcon, PencilIcon } from "@/components/viewer/icons";
import ProjectCrumb, { useProjectOf } from "@/components/projects/ProjectCrumb";
import PropertyViewer from "@/components/viewer/PropertyViewer";
import { api, ApiError } from "@/lib/api";
import { prepareModel } from "@/lib/viewer/prepareModel";

type Fetched =
  | { kind: "loading" }
  | { kind: "error"; message: string; status?: number; code?: string }
  | { kind: "loaded"; raw: unknown };

function StateCard({ title, children, actions, testId, tone = "neutral" }: {
  title: string; children: ReactNode; actions?: ReactNode; testId: string; tone?: "neutral" | "error";
}) {
  return (
    <div
      data-testid={testId}
      role={tone === "error" ? "alert" : undefined}
      className={`max-w-xl rounded-xl border p-6 ${tone === "error" ? "border-danger-line bg-danger-bg" : "border-border bg-surface"}`}
    >
      <h2 className={`font-display text-xl font-medium ${tone === "error" ? "text-danger" : ""}`}>{title}</h2>
      <div className={`mt-1.5 text-sm leading-relaxed ${tone === "error" ? "text-danger/85" : "text-muted"}`}>{children}</div>
      {actions && <div className="mt-5 flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

const primary = button("primary");
const secondary = button("secondary");

export default function ViewPropertyPage() {
  const { id } = useParams<{ id: string }>();
  const [fetched, setFetched] = useState<Fetched>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [projectId, setProjectId] = useState<string | null>(null);
  const project = useProjectOf(projectId);
  const [present] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("present") === "1");

  useEffect(() => {
    // Only for project context (breadcrumb, presentation title); the viewer works without it.
    api.getFloorPlan(id).then((fp) => setProjectId(fp.project_id ?? null), () => undefined);
  }, [id]);
  useEffect(() => {
    document.title = `${project ? `${project.name} · ` : ""}3D view · ARCHFLOW`;
  }, [project]);

  useEffect(() => {
    let cancelled = false;
    api
      .getStructure(id)
      // Treated as untrusted JSON: prepareModel checks everything before the 3D engine sees it.
      .then((raw: unknown) => !cancelled && setFetched({ kind: "loaded", raw }))
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError) setFetched({ kind: "error", message: err.message, status: err.status, code: err.code });
        else setFetched({ kind: "error", message: "The server's reply could not be read." });
      });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  const retry = useCallback(() => {
    setFetched({ kind: "loading" });
    setAttempt((a) => a + 1);
  }, []);

  // The whole pipeline: JSON -> checked FloorPlan -> geometry engine -> Scene3D -> viewer.
  const model = useMemo(() => {
    if (fetched.kind === "loaded") return prepareModel(fetched.raw);
    // The server found the saved plan damaged: same situation as an invalid plan, retrying won't help.
    if (fetched.kind === "error" && fetched.code === "invalid_structure") return { kind: "invalid" as const, message: fetched.message };
    return null;
  }, [fetched]);
  const loadError = fetched.kind === "error" && !model ? fetched : null;
  const editLink = `/plans/${id}/edit`;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className={`${pageWidth} flex-1 pb-16 pt-8 sm:pt-10`}>
        <div className="mb-7">
          <PageHeader
            eyebrow={<ProjectCrumb project={project} fallback="New project · Step 3 of 3" current="3D view" />}
            title={project ? project.name : "Your property in 3D"}
            lead="Walk around the model, look from above, and fly into any room. It's built from the saved floor plan and updates whenever the plan does."
            actions={<>
              <Link href={editLink} className={secondary}><PencilIcon /> Edit floor plan</Link>
              {project && <Link href={`/projects/${project.id}`} className={primary}><LinkIcon /> Share with buyers</Link>}
            </>}
          />
        </div>

        {fetched.kind === "loading" && (
          <div
            role="status"
            data-testid="viewer-loading"
            className="flex h-[62vh] min-h-[380px] items-center justify-center gap-2.5 rounded-xl border border-border bg-surface text-sm text-muted lg:h-[76vh]"
          >
            <Spinner /> Loading the model…
          </div>
        )}

        {loadError &&
          (loadError.status === 404 ? (
            <StateCard testId="plan-not-found" tone="error" title="Floor plan not found"
              actions={<Link href="/projects/new" className={primary}>Upload a floor plan</Link>}>
              {loadError.message} It may have been removed, or the link is incomplete.
            </StateCard>
          ) : (
            <StateCard testId="plan-load-error" tone="error" title="Could not load the floor plan"
              actions={<button type="button" onClick={retry} className={primary}>Try again</button>}>
              {loadError.message}
            </StateCard>
          ))}

        {model?.kind === "invalid" && (
          <StateCard testId="plan-invalid" tone="error" title="This floor plan cannot be displayed"
            actions={<Link href="/projects/new" className={primary}>Upload the plan again</Link>}>
            {model.message}
          </StateCard>
        )}

        {model?.kind === "empty" && (
          <StateCard testId="empty-model" title="Nothing to show yet"
            actions={<Link href={editLink} className={primary}>Open the editor</Link>}>
            This plan has no walls or rooms. Trace some in the editor, save, and come back.
          </StateCard>
        )}

        {model?.kind === "no-geometry" && (
          <StateCard testId="no-geometry" title="No 3D model could be built"
            actions={<Link href={editLink} className={primary}>Fix it in the editor</Link>}>
            <p>The plan has elements, but none of them could be turned into geometry:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {model.notes.slice(0, 8).map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </StateCard>
        )}

        {model?.kind === "ready" && (
          <PropertyViewer planId={id} scene={model.scene} stats={model.stats} notes={model.notes}
            title={project?.name} subtitle={project?.address || undefined} startPresenting={present} />
        )}
      </main>
    </div>
  );
}
