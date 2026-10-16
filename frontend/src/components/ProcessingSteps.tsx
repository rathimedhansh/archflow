import { Spinner } from "@/components/ui";
import { CheckIcon } from "@/components/viewer/icons";

export type StepStatus = "pending" | "running" | "done";

export interface Step {
  key: string;
  label: string;
  status: StepStatus;
  /** What the step found, shown once it is done (e.g. "9 walls"). */
  detail?: string;
}

interface Props {
  steps: Step[];
  fileName?: string | null;
  /** Upload progress 0..1 for the running step, when known. */
  progress?: number | null;
}

/** An honest step list: each step only turns done when the server says so. */
export default function ProcessingSteps({ steps, fileName, progress = null }: Props) {
  const done = steps.filter((s) => s.status === "done").length;
  return (
    <div className="rounded-xl border border-border bg-surface p-6 sm:p-7" role="status" aria-live="polite" data-testid="processing-steps">
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <p className="font-display text-xl font-medium">Reading your floor plan</p>
          {fileName && <p className="mt-1 truncate text-sm text-muted">{fileName}</p>}
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted">{done} of {steps.length}</span>
      </div>
      <ol className="relative space-y-4 before:absolute before:bottom-3 before:left-[11px] before:top-3 before:w-px before:bg-border">
        {steps.map((step) => {
          const isDone = step.status === "done";
          const current = step.status === "running";
          return (
            <li key={step.key} className="relative flex items-start gap-3.5" data-step={step.key} data-status={step.status}>
              <span
                className={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${
                  isDone ? "border-accent bg-accent text-on-accent" : current ? "border-accent bg-surface text-accent" : "border-border-strong bg-surface"
                }`}
              >
                {isDone ? <CheckIcon className="h-3.5 w-3.5" /> : current ? <Spinner className="h-3.5 w-3.5" /> : null}
              </span>
              <span className="min-w-0 pt-0.5">
                <span className={`text-[15px] ${isDone ? "text-foreground" : current ? "font-medium text-foreground" : "text-muted"}`}>
                  {step.label}
                  {current && progress !== null && <span className="tabular-nums text-muted"> · {Math.round(progress * 100)}%</span>}
                </span>
                {isDone && step.detail && <span className="block truncate text-[13px] text-muted">{step.detail}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {progress !== null && (
        <div className="mt-6 h-1 overflow-hidden rounded-full bg-stone" aria-hidden>
          <div className="h-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
    </div>
  );
}
