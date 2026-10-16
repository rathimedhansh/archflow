"use client";

import Link from "next/link";
import { memo } from "react";
import type { SceneSpace, SceneStats } from "@/lib/geometry3d";
import { ENVIRONMENT_OPTIONS, type EnvironmentSetting } from "@/lib/viewer/environment";
import { LAYER_INFO, type LayerKey, type Layers } from "@/lib/viewer/layers";
import { CheckIcon, WarningIcon } from "./icons";

interface Props {
  planId: string;
  /** "public": no links into the editor (buyer share pages). */
  audience?: "developer" | "public";
  stats: SceneStats;
  spaces: SceneSpace[];
  notes: string[];
  fingerprint: string;
  layers: Layers;
  onToggleLayer: (key: LayerKey) => void;
  selectedRoomId: string | null;
  onSelectRoom: (space: SceneSpace | null) => void;
  environment: EnvironmentSetting;
  onEnvironment: (value: EnvironmentSetting) => void;
}

const Section = ({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) => (
  <section className="border-b border-border px-5 py-5 last:border-b-0" data-testid={testId}>
    <h3 className="eyebrow mb-3">{title}</h3>
    {children}
  </section>
);

/** Side panel: what the buyer is looking at, and what to show. */
function PropertyPanel({ planId, audience = "developer", stats, spaces, notes, fingerprint, layers, onToggleLayer, selectedRoomId, onSelectRoom, environment, onEnvironment }: Props) {
  const approx = stats.calibrated ? "" : "≈ ";
  const m = (v: number) => `${approx}${v.toFixed(2)} m`;
  const counts: Record<LayerKey, number | null> = {
    walls: stats.walls, floors: stats.rooms, doors: stats.doors, windows: stats.windows, labels: stats.rooms, grid: null,
  };

  return (
    <div className="text-sm">
      <Section title="Property" testId="property-info">
        <div className="grid grid-cols-2 divide-x divide-border">
          <div className="pr-4">
            <div className="font-display text-[1.9rem] font-medium leading-none tabular-nums" data-testid="stat-area">
              {approx}
              {stats.floorArea.toFixed(1)}
              <span className="ml-1 font-sans text-sm font-normal text-muted">m²</span>
            </div>
            <div className="mt-1.5 text-xs text-muted">Floor area{stats.calibrated ? "" : " (approx.)"}</div>
          </div>
          <div className="pl-4">
            <div className="font-display text-[1.9rem] font-medium leading-none tabular-nums" data-testid="stat-rooms">{stats.rooms}</div>
            <div className="mt-1.5 text-xs text-muted">{stats.rooms === 1 ? "Room" : "Rooms"}</div>
          </div>
        </div>

        <dl className="mt-5 divide-y divide-border border-t border-border" data-testid="scene-stats">
          {(
            [
              ["Walls", String(stats.walls)],
              ["Doors", String(stats.doors)],
              ["Windows", String(stats.windows)],
              ["Footprint", `${approx}${stats.footprint.width.toFixed(2)} × ${stats.footprint.depth.toFixed(2)} m`],
              ["Wall height", m(stats.height)],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 py-1.5">
              <dt className="text-muted">{k}</dt>
              <dd className="tabular-nums">{v}</dd>
            </div>
          ))}
          <div className="flex justify-between gap-3 py-1.5">
            <dt className="text-muted">Scale</dt>
            <dd data-testid="stat-scale">
              {stats.calibrated ? (
                <span className="inline-flex items-center gap-1 text-accent">
                  <CheckIcon className="h-3.5 w-3.5" /> Calibrated
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-warning">
                  <WarningIcon className="h-3.5 w-3.5" /> Not calibrated
                </span>
              )}
            </dd>
          </div>
        </dl>

        {!stats.calibrated && (
          <p role="note" className="mt-4 rounded-lg border border-warning-line bg-warning-bg px-3 py-2.5 text-[13px] leading-snug text-warning">
            <strong className="font-semibold">Measurements are not verified.</strong> The plan&apos;s scale was never
            calibrated, so dimensions and areas are only approximate and may not represent the real building.
            {audience === "developer" && (
              <>
                {" "}
                <Link href={`/plans/${planId}/edit`} className="font-medium underline decoration-warning/40 underline-offset-2 hover:decoration-warning">
                  Calibrate in the editor
                </Link>
              </>
            )}
          </p>
        )}
      </Section>

      {spaces.length > 0 && (
        <Section title="Rooms" testId="room-list">
          <p className="-mt-1 mb-2 text-xs text-muted">Choose a room to fly to it.</p>
          <ul className="-mx-2 space-y-0.5">
            {spaces.map((s) => {
              const selected = s.id === selectedRoomId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelectRoom(selected ? null : s)}
                    className={`flex w-full items-center justify-between gap-3 rounded-md px-2 py-2 text-left transition-colors ${
                      selected ? "bg-accent-soft font-medium text-accent" : "hover:bg-stone/70"
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${selected ? "bg-accent" : "bg-border-strong"}`} />
                      <span className="truncate">{s.name}</span>
                    </span>
                    <span className={`shrink-0 text-xs tabular-nums ${selected ? "text-accent" : "text-muted"}`}>
                      {approx}
                      {s.area.toFixed(1)} m²
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selectedRoomId && (
            <button type="button" onClick={() => onSelectRoom(null)} className="mt-2 text-xs font-medium text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent">
              ← Show the whole property
            </button>
          )}
        </Section>
      )}

      <Section title="Show" testId="layer-controls">
        <ul className="space-y-1">
          {LAYER_INFO.map(({ key, label, shortcut }) => {
            const count = counts[key];
            // The grid is drawn on the plain studio floor only, not over the surroundings.
            const gridHidden = key === "grid" && environment !== "off";
            const disabled = count === 0 || gridHidden;
            return (
              <li key={key}>
                <label
                  className={`flex items-center justify-between gap-3 rounded-md px-1 py-1.5 ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer"}`}
                  title={gridHidden ? "Shown when Surroundings is Off" : undefined}
                >
                  <span>
                    {label}
                    {count !== null && <span className="ml-1.5 text-xs text-muted">({count})</span>}
                    {shortcut && <kbd className="ml-1.5 rounded border border-border px-1 font-mono text-[10px] text-muted">{shortcut}</kbd>}
                    {gridHidden && <span className="ml-1.5 text-xs text-muted">(surroundings on)</span>}
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    data-layer={key}
                    checked={layers[key] && !disabled}
                    disabled={disabled}
                    onChange={() => onToggleLayer(key)}
                    className="peer sr-only"
                  />
                  <span
                    aria-hidden
                    className="relative h-5 w-9 shrink-0 rounded-full bg-border transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent/60 after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4"
                  />
                </label>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Surroundings" testId="environment-controls">
        <div
          role="radiogroup"
          aria-label="Surroundings"
          className="grid grid-cols-4 gap-0.5 rounded-lg bg-stone p-0.5"
          onKeyDown={(e) => {
            // Arrow keys move the choice, as in any radio group (one tab stop for the group).
            const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            const n = ENVIRONMENT_OPTIONS.length;
            const i = ENVIRONMENT_OPTIONS.findIndex((o) => o.value === environment);
            const next = ENVIRONMENT_OPTIONS[(i + step + n) % n].value;
            onEnvironment(next);
            e.currentTarget.querySelector<HTMLButtonElement>(`[data-environment="${next}"]`)?.focus();
          }}
        >
          {ENVIRONMENT_OPTIONS.map(({ value, label }) => {
            const checked = environment === value;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                data-environment={value}
                onClick={() => onEnvironment(value)}
                className={`min-h-9 rounded-md px-1 py-1.5 text-xs font-medium transition-[background-color,color,box-shadow] focus-visible:outline-2 focus-visible:outline-accent ${
                  checked ? "bg-surface text-accent shadow-[0_1px_2px_rgb(34_38_31/0.12)]" : "text-muted hover:text-foreground"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <p className="mt-2.5 text-xs leading-relaxed text-muted" data-testid="environment-disclaimer">
          Illustrative only: the road, landscaping and trees are generated for presentation and do not show the property&apos;s
          real location or site.
        </p>
      </Section>

      {notes.length > 0 && (
        <Section title="Adjustments">
          <div data-testid="scene-warnings">
            <p className="mb-2 font-medium text-warning">
              {notes.length} thing{notes.length > 1 ? "s" : ""} in the plan couldn&apos;t be shown exactly:
            </p>
            <ul className="list-disc space-y-1 pl-4 text-[13px] text-muted">
              {notes.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        </Section>
      )}

      {audience === "developer" && <Section title="Model">
        <dl className="space-y-1 text-xs text-muted">
          <div className="flex justify-between gap-3">
            <dt>Triangles</dt>
            <dd className="font-mono tabular-nums" data-testid="stat-triangles">{stats.triangles.toLocaleString("en-US")}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt>Fingerprint</dt>
            <dd className="font-mono" title="Same plan, same fingerprint: the model is generated deterministically.">{fingerprint}</dd>
          </div>
        </dl>
      </Section>}
    </div>
  );
}

export default memo(PropertyPanel);
