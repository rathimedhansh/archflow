"use client";

import { useEffect, useState } from "react";
import { api, type HealthResponse } from "@/lib/api";

type State =
  | { kind: "loading" }
  | { kind: "online"; health: HealthResponse }
  | { kind: "offline" };

export default function ApiStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((health) => !cancelled && setState({ kind: "online", health }))
      .catch(() => !cancelled && setState({ kind: "offline" }));
    return () => {
      cancelled = true;
    };
  }, []);

  const dot =
    state.kind === "online"
      ? "bg-success"
      : state.kind === "offline"
        ? "bg-danger"
        : "bg-[#c08a2c] animate-pulse";

  const label =
    state.kind === "online"
      ? "Engine online"
      : state.kind === "offline"
        ? "Engine offline"
        : "Connecting…";

  // Quiet when all is well; spelled out when the backend cannot be reached.
  return (
    <div
      role="status"
      title={state.kind === "online" ? `ARCHFLOW engine v${state.health.version} is running` : state.kind === "offline" ? "The ARCHFLOW engine (backend) cannot be reached. Uploads and saving will not work until it is running." : undefined}
      className={`inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs ${state.kind === "offline" ? "border border-danger-line bg-danger-bg font-medium text-danger" : "text-muted"}`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      <span className={state.kind === "offline" ? "" : "hidden sm:inline"}>{label}</span>
      {state.kind !== "offline" && <span className="sr-only sm:hidden">{label}</span>}
    </div>
  );
}
