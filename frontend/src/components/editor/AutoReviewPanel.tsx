"use client";

import { Badge } from "@/components/ui";
import type { Selection } from "@/lib/floorplan/types";
import { confidenceBand, type ReviewItem } from "@/lib/interpretation/result";
import type { InterpretationReport } from "@/lib/interpretation/types";

interface Props {
  report: InterpretationReport;
  items: ReviewItem[];
  /** True while the automatic proposal has not been saved as the user's plan. */
  unsaved: boolean;
  highlight: boolean;
  onHighlight: (on: boolean) => void;
  onSelect: (sel: Selection) => void;
  onCalibrate: () => void;
}

const KIND_LABEL = { wall: "Wall", room: "Room", door: "Door", window: "Window" } as const;
const BAND_TONE = { high: "success", medium: "warning", low: "danger" } as const;

/** Everything the detector knows about its own uncertainty, as a correction checklist. */
export default function AutoReviewPanel({ report, items, unsaved, highlight, onHighlight, onSelect, onCalibrate }: Props) {
  const band = confidenceBand(report.overall_confidence);
  const omitted = Object.entries(report.omitted).filter(([, n]) => n);

  return (
    <div className="rounded-xl border border-border bg-surface p-4 text-sm" data-testid="auto-review">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">Detected automatically</h3>
        <Badge tone={BAND_TONE[band]}>
          <span title="Heuristic detector score, not a probability">{Math.round(report.overall_confidence * 100)}% · {band}</span>
        </Badge>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        {unsaved && <strong className="font-medium text-warning">Not saved yet. </strong>}
        Compare it with the drawing: select anything wrong and press Delete, draw what&apos;s missing with the tools, then save.
      </p>

      <div className="mt-3 rounded-lg bg-stone/70 px-3 py-2.5 text-[13px]">
        <p className="font-medium">Scale {report.scale?.source === "doors" ? "estimated from door widths" : "assumed"}</p>
        {report.scale?.detail && <p className="mt-0.5 leading-snug text-muted">{report.scale.detail}</p>}
        <button type="button" onClick={onCalibrate} className="mt-1.5 font-medium text-accent underline decoration-accent/30 underline-offset-2 hover:decoration-accent">Set the real scale</button>
      </div>

      {items.length > 0 ? (
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <h4 className="eyebrow">Needs review · {items.length}</h4>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" className="accent-[var(--accent)]" checked={highlight} onChange={(e) => onHighlight(e.target.checked)} /> Highlight
            </label>
          </div>
          <ul className="mt-2 max-h-48 space-y-0.5 overflow-auto pr-1" data-testid="review-items">
            {items.map((it) => (
              <li key={it.id}>
                <button type="button" onClick={() => onSelect({ kind: it.kind, id: it.id })}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-warning-bg"
                  title={it.evidence}>
                  <span className="truncate">{KIND_LABEL[it.kind]} <span className="text-xs text-muted">{it.label}</span></span>
                  <span className="shrink-0 text-xs tabular-nums text-warning">{Math.round(it.confidence * 100)}%</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-[13px] text-muted">Nothing was flagged as uncertain. It&apos;s still worth checking against the drawing.</p>
      )}

      {omitted.length > 0 && (
        <p className="mt-3 text-[13px] text-muted">
          Left out as too uncertain: {omitted.map(([k, n]) => `${n} ${n === 1 ? k.slice(0, -1) : k}`).join(", ")}. Add them by hand if they exist.
        </p>
      )}

      {report.warnings.length > 0 && (
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer font-medium text-warning">{report.warnings.length} detector note{report.warnings.length > 1 ? "s" : ""}</summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-muted">
            {report.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
