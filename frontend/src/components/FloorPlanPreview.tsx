import Link from "next/link";
import { button } from "@/components/ui";
import { ArrowRightIcon, SparkIcon } from "@/components/viewer/icons";
import { absoluteUrl, type FloorPlan } from "@/lib/api";
import { formatBytes } from "@/lib/upload";

interface Props {
  plan: FloorPlan;
  onReset: () => void;
  /** Offer automatic detection for this uploaded plan. */
  onAutoGenerate?: () => void;
}

export default function FloorPlanPreview({ plan, onReset, onAutoGenerate }: Props) {
  const details: [string, string][] = [
    ["File", plan.original_filename],
    ["Dimensions", `${plan.width} × ${plan.height} px`],
    ["Original format", plan.source_format],
    ["Prepared size", formatBytes(plan.size_bytes)],
    ["Plan ID", plan.id.slice(0, 8)],
  ];

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="drafting-paper overflow-hidden rounded-xl border border-border">
        {/* Plain <img>: the source is a dynamic backend URL, not an optimizable static asset. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={absoluteUrl(plan.image_url)}
          alt={`Floor plan ${plan.original_filename}`}
          width={plan.width}
          height={plan.height}
          className="max-h-[66vh] w-full object-contain p-4 mix-blend-multiply"
        />
      </div>

      <aside className="flex flex-col gap-6">
        <div>
          <h2 className="font-display text-2xl font-medium">Plan uploaded</h2>
          <p className="mt-1.5 text-sm text-muted">Next, define its walls and rooms, or let ARCHFLOW detect them for you.</p>
        </div>
        <dl className="divide-y divide-border border-y border-border text-sm">
          {details.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-2.5">
              <dt className="text-muted">{k}</dt>
              <dd className="truncate tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-col gap-2.5">
          {onAutoGenerate && (
            <button type="button" onClick={onAutoGenerate} className={button("primary", "lg", "w-full")}>
              <SparkIcon /> Auto-generate floor plan
            </button>
          )}
          <Link href={`/plans/${plan.id}/edit`} className={button(onAutoGenerate ? "secondary" : "primary", "md", "w-full")}>
            Define walls &amp; rooms <ArrowRightIcon />
          </Link>
          <button type="button" onClick={onReset} className={button("quiet", "md", "w-full")}>Upload a different plan</button>
        </div>
      </aside>
    </div>
  );
}
