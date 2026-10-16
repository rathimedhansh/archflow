import Link from "next/link";
import { Badge, button, Notice } from "@/components/ui";
import { ArrowRightIcon } from "@/components/viewer/icons";
import { absoluteUrl, type FloorPlan } from "@/lib/api";
import { confidenceBand, elementCounts } from "@/lib/interpretation/result";
import type { Interpretation } from "@/lib/interpretation/types";

interface Props {
  image: FloorPlan;
  interpretation: Interpretation;
  onReset: () => void;
}

const BAND_TEXT = { high: "High", medium: "Medium", low: "Low" } as const;
const BAND_TONE = { high: "success", medium: "warning", low: "danger" } as const;

/** What automatic detection produced, before the user opens it in the editor. */
export default function AutoResultSummary({ image, interpretation, onReset }: Props) {
  const { plan, report } = interpretation;
  const counts = elementCounts(plan);
  const review = report.elements.filter((e) => e.needs_review).length;
  const band = confidenceBand(report.overall_confidence);
  const edit = `/plans/${image.id}/edit`;

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]" data-testid="auto-result">
      <div className="drafting-paper overflow-hidden rounded-xl border border-border">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={absoluteUrl(image.image_url)} alt={`Floor plan ${image.original_filename}`} width={image.width} height={image.height}
          className="max-h-[66vh] w-full object-contain p-4 mix-blend-multiply" />
      </div>

      <aside className="flex flex-col gap-6">
        {report.supported ? (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-2xl font-medium">Here&apos;s what we found</h2>
              <Badge tone={BAND_TONE[band]} className="!font-normal">
                <span title="Heuristic detector score, not a probability">{BAND_TEXT[band]} confidence · {Math.round(report.overall_confidence * 100)}%</span>
              </Badge>
            </div>
            <dl className="mt-5 grid grid-cols-4 divide-x divide-border rounded-lg border border-border bg-surface text-center" data-testid="auto-counts">
              {(Object.entries(counts) as [string, number][]).map(([k, v]) => (
                <div key={k} className="px-1 py-3">
                  <dd className="font-display text-2xl leading-none tabular-nums">{v}</dd>
                  <dt className="mt-1.5 text-xs capitalize text-muted">{k}</dt>
                </div>
              ))}
            </dl>
            <p className="mt-4 text-sm leading-relaxed text-muted">
              {review > 0 ? `${review} element${review > 1 ? "s" : ""} flagged for review. ` : "Nothing was flagged, but it's still worth checking against the drawing. "}
              {report.scale?.source === "doors" ? "The scale was estimated from door widths" : "The scale was assumed"}; you can set the real scale in the editor.
            </p>
            {report.warnings.length > 0 && (
              <Notice tone="warning" className="mt-4" title="Worth a look">
                <ul className="space-y-1">
                  {report.warnings.slice(0, 4).map((w) => <li key={w}>{w}</li>)}
                  {report.warnings.length > 4 && <li className="opacity-80">…and {report.warnings.length - 4} more in the editor.</li>}
                </ul>
              </Notice>
            )}
          </div>
        ) : (
          <Notice tone="warning" title="This drawing could not be read automatically">
            <p>{report.reason}</p>
            <p className="mt-2 opacity-90">Nothing was generated. You can trace the walls and rooms by hand instead; it only takes a few minutes.</p>
          </Notice>
        )}

        <div className="flex flex-col gap-2.5">
          {report.supported ? (
            <>
              <Link href={`${edit}?source=auto`} className={button("primary", "lg", "w-full")}>
                Review &amp; correct in editor <ArrowRightIcon />
              </Link>
              <Link href={edit} className={button("secondary", "md", "w-full")}>Ignore the result and trace by hand</Link>
            </>
          ) : (
            <Link href={edit} className={button("primary", "lg", "w-full")}>Trace walls &amp; rooms by hand <ArrowRightIcon /></Link>
          )}
          <button type="button" onClick={onReset} className={button("quiet", "md", "w-full")}>Upload a different plan</button>
        </div>
      </aside>
    </div>
  );
}
