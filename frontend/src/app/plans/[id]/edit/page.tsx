"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import FloorPlanEditor from "@/components/editor/FloorPlanEditor";
import ProjectCrumb, { useProjectOf } from "@/components/projects/ProjectCrumb";
import SiteHeader from "@/components/SiteHeader";
import { button, Loading, Notice, PageHeader, pageWidth } from "@/components/ui";
import { api, ApiError, type FloorPlan } from "@/lib/api";
import type { FloorPlanData } from "@/lib/floorplan/types";
import { acceptInterpretation } from "@/lib/interpretation/result";
import type { Interpretation } from "@/lib/interpretation/types";

type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; image: FloorPlan; plan: FloorPlanData; interpretation: Interpretation | null; proposal: boolean };

/** The stored automatic result, or null when there is none or it is unusable. */
async function loadInterpretation(id: string): Promise<Interpretation | null> {
  try {
    const accepted = acceptInterpretation(await api.getInterpretation(id), id);
    return accepted.ok ? accepted.interpretation : null;
  } catch {
    return null; // 404 (never analysed) or damaged: the editor works without it
  }
}

export default function EditFloorPlanPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<Loaded>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    // Read on the client only: `?source=auto` opens the automatic proposal instead of the saved plan.
    const wantsProposal = new URLSearchParams(window.location.search).get("source") === "auto";
    (async () => {
      const [image, saved] = await Promise.all([api.getFloorPlan(id), api.getStructure(id)]);
      // Only plans that involve detection have a stored result worth fetching.
      const interpretation = wantsProposal || saved.provenance === "opencv" ? await loadInterpretation(id) : null;
      if (cancelled) return;
      if (wantsProposal && !interpretation?.report.supported) {
        return setState({ kind: "error", message: "There is no usable automatic result for this plan. Run Auto Generate again, or trace it by hand." });
      }
      const proposal = wantsProposal && !!interpretation;
      setState({
        kind: "ready", image, proposal,
        plan: proposal ? interpretation!.plan : saved,
        interpretation,
      });
    })().catch((err) => {
      if (!cancelled) setState({ kind: "error", message: err instanceof ApiError ? err.message : "Could not load this floor plan." });
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Once the proposal is saved it is the user's plan: a reload must open the saved version.
  const onSaved = useCallback(() => {
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  const proposal = state.kind === "ready" && state.proposal;
  const project = useProjectOf(state.kind === "ready" ? state.image.project_id : null);
  useEffect(() => {
    document.title = `${project ? `${project.name} · ` : ""}Floor plan editor · ARCHFLOW`;
  }, [project]);

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className={`${pageWidth} flex-1 pb-20 pt-8 sm:pt-10`}>
        <div className="mb-8">
          <PageHeader
            eyebrow={<ProjectCrumb project={project} fallback="New project · Step 2 of 3" current="Floor plan" />}
            title={proposal ? "Review the detected plan" : "Define walls & rooms"}
            lead={proposal
              ? "Walls, rooms, doors and windows were found automatically. Compare them with the drawing, fix what's wrong, add what's missing, set the scale, then save."
              : "Trace the plan to build its structure, or let ARCHFLOW detect it for you and correct the result here."}
          />
        </div>

        {state.kind === "loading" && <Loading>Loading the floor plan…</Loading>}
        {state.kind === "error" && (
          <Notice tone="danger" className="max-w-xl" title="The editor couldn't open this plan"
            action={<Link href="/projects" className={button("secondary", "sm")}>Go to your properties</Link>}>
            {state.message}
          </Notice>
        )}
        {state.kind === "ready" && (
          <FloorPlanEditor
            image={state.image} initialPlan={state.plan} interpretation={state.interpretation}
            startUnsaved={state.proposal} onSaved={onSaved}
          />
        )}
      </main>
    </div>
  );
}
