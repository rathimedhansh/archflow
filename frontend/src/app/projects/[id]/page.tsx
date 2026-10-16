"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import SiteHeader from "@/components/SiteHeader";
import ProjectForm from "@/components/projects/ProjectForm";
import SharePanel from "@/components/projects/SharePanel";
import UploadFlow from "@/components/projects/UploadFlow";
import { StageBadge } from "@/components/projects/ui";
import { button, Loading, Notice, PageHeader, pageWidth, Panel, SectionTitle } from "@/components/ui";
import { ArrowRightIcon, CheckIcon, CubeIcon, PencilIcon, PlayIcon, TrashIcon, UploadIcon } from "@/components/viewer/icons";
import { absoluteUrl, api, ApiError, type Project } from "@/lib/api";
import { nextAction, projectSteps, timeAgo } from "@/lib/projects/status";

type Loaded = { kind: "loading" } | { kind: "error"; message: string; status?: number } | { kind: "ready"; project: Project };

function Steps({ project }: { project: Project }) {
  return (
    <ol className="relative mt-5 space-y-5 before:absolute before:bottom-2 before:left-[11px] before:top-2 before:w-px before:bg-border" data-testid="project-steps">
      {projectSteps(project).map((s, i) => (
        <li key={s.key} className="relative flex gap-3.5" data-step={s.key} data-done={s.done}>
          <span className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums ${
            s.done ? "border-accent bg-accent text-on-accent" : "border-border-strong bg-surface text-muted"}`}>
            {s.done ? <CheckIcon className="h-3.5 w-3.5" /> : i + 1}
          </span>
          <span className="min-w-0">
            <span className={`block text-sm ${s.done ? "text-foreground/75" : "font-medium text-foreground"}`}>{s.label}</span>
            <span className="mt-0.5 block text-[13px] leading-snug text-muted">{s.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function PlanSection({ project, onReplace }: { project: Project; onReplace: () => void }) {
  const fp = project.floorplan!;
  const plan = project.plan;
  const saved = !!plan?.saved && !plan.damaged;
  const approx = plan?.calibrated ? "" : "≈ ";
  const edit = `/plans/${fp.id}/edit${!plan?.saved && plan?.auto_detected ? "?source=auto" : ""}`;
  return (
    <section data-testid="plan-card" aria-labelledby="plan-heading">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <SectionTitle id="plan-heading">Floor plan</SectionTitle>
        <p className="text-[13px] text-muted">
          {fp.original_filename} · {fp.width} × {fp.height} px{plan?.saved_at ? ` · saved ${timeAgo(plan.saved_at)}` : ""}
        </p>
      </div>
      <div className="drafting-paper mt-3 overflow-hidden rounded-xl border border-border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={absoluteUrl(fp.image_url)} alt={`Floor plan of ${project.name}`} width={fp.width} height={fp.height}
          className="max-h-[52vh] w-full object-contain p-5 mix-blend-multiply" />
      </div>

      {plan?.damaged ? (
        <Notice tone="danger" className="mt-4" title="The saved floor plan can't be opened">It is damaged. Upload the plan again to continue.</Notice>
      ) : saved ? (
        <dl className="mt-4 grid grid-cols-3 gap-y-4 rounded-xl border border-border bg-surface py-4 sm:grid-cols-6 sm:divide-x sm:divide-border" data-testid="plan-stats">
          {([
            ["Rooms", plan!.rooms], ["Area", `${approx}${plan!.floor_area_m2.toFixed(1)} m²`], ["Walls", plan!.walls],
            ["Doors", plan!.doors], ["Windows", plan!.windows], ["Scale", plan!.calibrated ? "Set" : "Not set"],
          ] as const).map(([k, v]) => (
            <div key={k} className="px-3 text-center">
              <dd className={`font-display text-xl leading-tight tabular-nums ${k === "Scale" && !plan!.calibrated ? "text-warning" : ""}`}>{v}</dd>
              <dt className="mt-1 text-xs text-muted">{k}</dt>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-4 text-sm text-muted">
          {plan?.auto_detected ? "A detected plan is waiting for your review. Nothing is saved yet." : "Nothing is saved yet. Trace or detect the plan in the editor."}
        </p>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        {saved && <Link href={`/plans/${fp.id}/view`} className={button("primary")}><CubeIcon /> View in 3D</Link>}
        <Link href={edit} className={button(saved ? "secondary" : "primary")}>
          <PencilIcon /> {saved ? "Edit floor plan" : plan?.auto_detected ? "Review detected plan" : "Open editor"}
        </Link>
        {saved && <Link href={`/plans/${fp.id}/view?present=1`} className={button("secondary")}><PlayIcon /> Present</Link>}
        <button type="button" onClick={onReplace} className={button("quiet", "md", "sm:ml-auto")}><UploadIcon /> Replace floor plan</button>
      </div>
    </section>
  );
}

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [state, setState] = useState<Loaded>({ kind: "loading" });
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(() => api.getProject(id).then(
    (project) => {
      setState({ kind: "ready", project });
      setUploading((u) => u ?? !project.floorplan); // start in upload mode only for a new property
    },
    (err) => setState({
      kind: "error", message: err instanceof ApiError ? err.message : "Could not load this property.",
      status: err instanceof ApiError ? err.status : undefined,
    }),
  ), [id]);
  useEffect(() => {
    load();
  }, [load]);

  const project = state.kind === "ready" ? state.project : null;
  useEffect(() => {
    if (project) document.title = `${project.name} · ARCHFLOW`;
  }, [project]);

  const run = async (fn: () => Promise<Project | void>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      if (next) setState({ kind: "ready", project: next });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const action = project ? nextAction(project) : null;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className={`${pageWidth} flex-1 pb-20 pt-8 sm:pt-10`}>
        <nav aria-label="Breadcrumb" className="mb-6 flex min-w-0 items-center gap-2 text-sm text-muted">
          <Link href="/projects" className="shrink-0 hover:text-foreground">Properties</Link>
          {project && <><span aria-hidden>/</span><span className="truncate text-foreground/80">{project.name}</span></>}
        </nav>

        {state.kind === "loading" && <Loading>Loading the property…</Loading>}
        {state.kind === "error" && (
          <div className="max-w-xl" data-testid={state.status === 404 ? "project-not-found" : "project-error"}>
            <Notice tone="danger" title={state.status === 404 ? "We can't find this property" : "The property couldn't be loaded"}
              action={<Link href="/projects" className={button("secondary", "sm")}>Back to your properties</Link>}>
              {state.status === 404 ? "It may have been deleted, or the link is incomplete." : state.message}
            </Notice>
          </div>
        )}

        {project && (
          <>
            {editing ? (
              <Panel className="max-w-2xl">
                <h1 className="mb-6 font-display text-2xl font-medium">Edit details</h1>
                <ProjectForm
                  initial={{ name: project.name, address: project.address, description: project.description }}
                  submitLabel="Save details" busy={busy} onCancel={() => setEditing(false)}
                  onSubmit={(fields) => void run(async () => {
                    const next = await api.updateProject(project.id, fields);
                    setEditing(false);
                    return next;
                  })}
                />
              </Panel>
            ) : (
              <PageHeader
                title={project.name}
                titleTestId="project-name"
                badge={<StageBadge project={project} />}
                lead={
                  <>
                    {project.address && <p className="text-foreground/75" data-testid="project-address">{project.address}</p>}
                    {project.description && <p className="mt-2 whitespace-pre-line">{project.description}</p>}
                    <button type="button" onClick={() => setEditing(true)} className={button("quiet", "sm", "-ml-3 mt-2")}>
                      <PencilIcon className="h-3.5 w-3.5" /> Edit details
                    </button>
                  </>
                }
                actions={action && !uploading && (
                  action.href
                    ? <Link href={action.href} className={button("primary")} data-testid="next-action">{action.label} <ArrowRightIcon /></Link>
                    : <button type="button" disabled={busy} data-testid="next-action" className={button("primary")}
                        onClick={() => action.action === "upload" ? setUploading(true) : void run(() => api.publishShare(project.id))}>
                        {action.label} <ArrowRightIcon />
                      </button>
                )}
              />
            )}

            {error && <Notice tone="danger" className="mt-6 max-w-2xl" title="That didn't work">{error}</Notice>}

            <div className="mt-10 grid gap-10 lg:grid-cols-[minmax(0,1fr)_340px]">
              <div className="min-w-0">
                {uploading || !project.floorplan ? (
                  <Panel testId="upload-card">
                    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h2 className="font-display text-2xl font-medium">{project.plan?.saved ? "Replace the floor plan" : "Upload the floor plan"}</h2>
                        <p className="mt-1 text-sm text-muted">A PNG or JPG of the 2D plan. You&apos;ll review the result before anything is saved.</p>
                      </div>
                      {project.floorplan && (
                        <button type="button" onClick={() => setUploading(false)} className={button("quiet", "sm")}>Cancel</button>
                      )}
                    </div>
                    <UploadFlow projectId={project.id} onAttached={() => void load()} />
                  </Panel>
                ) : (
                  <PlanSection project={project} onReplace={async () => {
                    if (!project.plan?.saved || await confirm({
                      title: "Replace the floor plan?",
                      body: "The current plan stays on disk but is no longer used. A published buyer page keeps showing the old plan until you publish again.",
                      confirmLabel: "Upload a new plan",
                    })) {
                      setUploading(true);
                    }
                  }} />
                )}
              </div>

              <aside className="space-y-6">
                <Panel>
                  <SectionTitle>Progress</SectionTitle>
                  <Steps project={project} />
                </Panel>
                <SharePanel project={project} busy={busy}
                  onPublish={() => void run(() => api.publishShare(project.id))}
                  onUnpublish={async () => {
                    if (await confirm({
                      title: "Switch off the buyer link?",
                      body: "Anyone who has the link will no longer be able to open the property. You can publish a new link later.",
                      confirmLabel: "Switch off link", tone: "danger",
                    })) {
                      void run(() => api.unpublishShare(project.id));
                    }
                  }}
                />
                <section className="border-t border-border px-1 pt-5" aria-labelledby="danger-heading">
                  <h2 id="danger-heading" className="text-sm font-semibold">Delete this property</h2>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted">Removes the property, its floor plan and its buyer link. This can&apos;t be undone.</p>
                  <button type="button" className={button("danger", "sm", "mt-3")} disabled={busy} onClick={async () => {
                    if (await confirm({
                      title: `Delete “${project.name}”?`,
                      body: "The property, its floor plan and its buyer link are removed permanently.",
                      confirmLabel: "Delete property", tone: "danger",
                    })) {
                      void run(async () => {
                        await api.deleteProject(project.id);
                        router.push("/projects");
                      });
                    }
                  }}><TrashIcon className="h-3.5 w-3.5" /> Delete property</button>
                </section>
              </aside>
            </div>
          </>
        )}
      </main>
      {confirmDialog}
    </div>
  );
}
