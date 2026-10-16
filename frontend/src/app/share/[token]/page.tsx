"use client";

import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { EmptyPlanSketch } from "@/components/illustrations";
import Logo from "@/components/Logo";
import { pageWidth, Spinner } from "@/components/ui";
import PropertyViewer from "@/components/viewer/PropertyViewer";
import { api, ApiError, type SharedProperty } from "@/lib/api";
import { prepareModel } from "@/lib/viewer/prepareModel";

type Loaded =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: SharedProperty };

function Message({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <div data-testid={testId} className="mx-auto mt-12 flex max-w-lg flex-col items-center text-center">
      <EmptyPlanSketch className="w-48" />
      <h1 className="mt-8 font-display text-[1.75rem] font-medium leading-tight">{title}</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">{children}</p>
    </div>
  );
}

/** The buyer's page: read-only, no account, nothing that leads to editing. */
export default function SharedPropertyPage() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<Loaded>({ kind: "loading" });
  const [present] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("present") === "1");

  useEffect(() => {
    let cancelled = false;
    api.getSharedProperty(token)
      .then((data) => !cancelled && setState({ kind: "ready", data }))
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) setState({ kind: "gone" });
        else setState({ kind: "error", message: err instanceof ApiError ? err.message : "The property could not be loaded." });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // The published plan is untrusted JSON like any other: the same gate as the developer's viewer.
  const model = useMemo(() => (state.kind === "ready" ? prepareModel(state.data.plan) : null), [state]);
  const property = state.kind === "ready" ? state.data.property : null;
  useEffect(() => {
    if (property) document.title = `${property.name} · 3D property tour`;
  }, [property]);

  // Only facts the published plan actually contains; "≈" whenever the scale was never calibrated.
  const facts = model?.kind === "ready"
    ? [
        [`${model.stats.calibrated ? "" : "≈ "}${model.stats.floorArea.toFixed(1)} m²`, "floor area"],
        [String(model.stats.rooms), model.stats.rooms === 1 ? "room" : "rooms"],
        [`${model.stats.calibrated ? "" : "≈ "}${model.stats.footprint.width.toFixed(1)} × ${model.stats.footprint.depth.toFixed(1)} m`, "footprint"],
      ]
    : [];

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border/70">
        <div className={`${pageWidth} flex h-16 items-center justify-between`}>
          <Logo />
          <span className="eyebrow hidden sm:inline">Interactive 3D property tour</span>
        </div>
      </header>
      <main className={`${pageWidth} flex-1 pb-12 pt-8 sm:pt-12`}>
        {state.kind === "loading" && (
          <div role="status" className="flex h-[70vh] items-center justify-center gap-2.5 rounded-xl border border-border bg-surface text-sm text-muted">
            <Spinner /> Loading the property…
          </div>
        )}
        {state.kind === "gone" && (
          <Message testId="share-gone" title="This property link isn't available">
            The link may have been switched off, or it&apos;s incomplete. Please ask whoever sent it for a new link.
          </Message>
        )}
        {state.kind === "error" && <Message testId="share-error" title="The property couldn't be shown">{state.message}</Message>}

        {property && model && (
          <>
            <div className="mb-8 grid gap-x-12 gap-y-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
              <div className="min-w-0">
                <p className="eyebrow">Property tour</p>
                <h1 className="mt-3 font-display text-[2.2rem] font-medium leading-[1.08] tracking-[-0.012em] sm:text-[2.9rem]" data-testid="share-title">{property.name}</h1>
                {property.address && <p className="mt-2 text-[17px] text-foreground/75" data-testid="share-address">{property.address}</p>}
                {property.description && <p className="mt-4 max-w-2xl whitespace-pre-line text-[15px] leading-relaxed text-muted">{property.description}</p>}
              </div>
              {facts.length > 0 && (
                <dl className="flex flex-wrap gap-x-8 gap-y-4 border-t border-border pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
                  {facts.map(([value, label]) => (
                    <div key={label}>
                      <dd className="font-display text-[1.6rem] leading-none tabular-nums">{value}</dd>
                      <dt className="mt-1.5 text-xs text-muted">{label}</dt>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            {model.kind === "ready" ? (
              <PropertyViewer planId="shared" scene={model.scene} stats={model.stats} notes={model.notes} audience="public"
                title={property.name} subtitle={property.address || undefined} startPresenting={present} />
            ) : (
              <Message testId="share-unavailable" title="The 3D model isn't available">
                {model.kind === "invalid" ? model.message : "This property has no model to show yet."}
              </Message>
            )}
          </>
        )}
      </main>
      <footer className="border-t border-border">
        <p className={`${pageWidth} py-6 text-[13px] leading-relaxed text-muted`}>
          Generated from the architectural floor plan with ARCHFLOW. Room sizes are measured on the plan; please confirm final
          dimensions with the developer. Any surroundings shown are illustrative.
        </p>
      </footer>
    </div>
  );
}
