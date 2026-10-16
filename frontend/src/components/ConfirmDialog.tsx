"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { button } from "@/components/ui";

export interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
}

/**
 * A modal confirmation built on the native <dialog> (focus is trapped, Esc and the backdrop cancel),
 * replacing the browser's plain confirm box.
 * `const [confirm, dialog] = useConfirm()`; render `dialog`; `if (await confirm({...})) ...`.
 */
export function useConfirm() {
  const [request, setRequest] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => new Promise<boolean>((resolve) => {
    resolver.current?.(false); // a newer request replaces an unanswered one
    resolver.current = resolve;
    setRequest(options);
  }), []);
  const close = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setRequest(null);
  }, []);
  const dialog = request ? <ConfirmDialog {...request} onClose={close} /> : null;
  return [confirm, dialog] as const;
}

function ConfirmDialog({ title, body, confirmLabel, cancelLabel = "Cancel", tone = "primary", onClose }: ConfirmOptions & { onClose: (ok: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    // Start on the safe choice for destructive actions.
    if (tone === "danger") cancelRef.current?.focus();
  }, [tone]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-testid="confirm-dialog"
      onCancel={(e) => {
        e.preventDefault();
        onClose(false);
      }}
      onClick={(e) => e.target === ref.current && onClose(false)}
      className="m-auto w-[min(28rem,calc(100%-2rem))] rounded-xl border border-border bg-surface p-0 text-foreground shadow-soft"
    >
      <div className="p-6">
        <h2 id={titleId} className="font-display text-xl font-medium leading-snug">{title}</h2>
        {body && <div className="mt-2 text-sm leading-relaxed text-muted">{body}</div>}
      </div>
      <div className="flex flex-wrap justify-end gap-2.5 rounded-b-xl border-t border-border bg-background/60 px-6 py-4">
        <button ref={cancelRef} type="button" className={button("secondary")} onClick={() => onClose(false)}>{cancelLabel}</button>
        <button type="button" data-testid="confirm-accept"
          className={tone === "danger" ? button("primary", "md", "!bg-danger hover:!bg-[#7f2a1e]") : button("primary")}
          onClick={() => onClose(true)}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}
