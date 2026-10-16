"use client";

import { useState } from "react";
import { button, Notice, Panel, SectionTitle } from "@/components/ui";
import { CheckIcon, CopyIcon, ExternalIcon } from "@/components/viewer/icons";
import type { Project } from "@/lib/api";
import { shareUrl, timeAgo } from "@/lib/projects/status";

interface Props {
  project: Project;
  busy: boolean;
  onPublish: () => void;
  onUnpublish: () => void;
}

/** Publish, copy, update or switch off the read-only buyer page. */
export default function SharePanel({ project, busy, onPublish, onUnpublish }: Props) {
  // Rendered only after the project loads in the browser, so `window` is available.
  const [origin] = useState(() => (typeof window === "undefined" ? "" : window.location.origin));
  const [copied, setCopied] = useState(false);

  const share = project.share;
  const plan = project.plan;
  const shareable = !!plan?.saved && !plan.damaged && plan.walls + plan.rooms > 0;
  const url = share && origin ? shareUrl(origin, share.url_path) : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard can be refused (permissions, insecure origin): select the text so the user can copy it.
      (document.getElementById("share-url") as HTMLInputElement | null)?.select();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Panel testId="share-panel">
      <SectionTitle>Buyer page</SectionTitle>
      {!share ? (
        <>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            A read-only 3D page buyers open with a link. No account, no editing, just the property.
          </p>
          {shareable && !plan!.calibrated && (
            <Notice tone="warning" className="mt-4 !text-[13px]">The scale isn&apos;t set, so buyers will see a note that sizes are approximate.</Notice>
          )}
          <button type="button" onClick={onPublish} disabled={!shareable || busy} className={button("primary", "md", "mt-5 w-full")}>
            Publish buyer page
          </button>
          {!shareable && <p className="mt-2.5 text-[13px] text-muted">Save a floor plan with walls and rooms first.</p>}
        </>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="flex gap-2">
            <input id="share-url" data-testid="share-url" readOnly value={url} aria-label="Buyer link"
              onFocus={(e) => e.currentTarget.select()}
              className="h-10 min-w-0 flex-1 rounded-md border border-border-strong bg-background px-3 font-mono text-xs text-foreground/85 outline-none focus:border-accent" />
            <button type="button" onClick={() => void copy()} className={button("secondary", "md", "px-3")} aria-live="polite">
              {copied ? <><CheckIcon /> Copied</> : <><CopyIcon /> Copy</>}
            </button>
          </div>
          <p className={`flex items-start gap-2 text-[13px] leading-snug ${share.up_to_date ? "text-muted" : "text-warning"}`} data-testid="share-status">
            <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${share.up_to_date ? "bg-success" : "bg-[#c08a2c]"}`} />
            {share.up_to_date
              ? `Published ${timeAgo(share.published_at)} · shows the latest saved plan.`
              : "The plan or details changed since publishing. Buyers still see the older version."}
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={share.url_path} target="_blank" rel="noopener" className={button(share.up_to_date ? "primary" : "secondary")}>
              Open buyer page <ExternalIcon />
            </a>
            <button type="button" onClick={onPublish} disabled={busy || !shareable} className={button(share.up_to_date ? "secondary" : "primary")}>
              {share.up_to_date ? "Republish" : "Update buyer page"}
            </button>
          </div>
          <button type="button" onClick={onUnpublish} disabled={busy} className="text-[13px] font-medium text-danger underline decoration-danger/30 underline-offset-[3px] hover:decoration-danger">
            Switch off link
          </button>
        </div>
      )}
    </Panel>
  );
}
