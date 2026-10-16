"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { acceptInterpretation } from "@/lib/interpretation/result";
import { applyStage, initialProgress, type StageProgress } from "@/lib/interpretation/stream";
import type { Interpretation } from "@/lib/interpretation/types";

export type AutoState =
  | { phase: "idle" }
  | { phase: "running"; progress: StageProgress[] }
  | { phase: "done"; progress: StageProgress[]; interpretation: Interpretation; notes: string[] }
  | { phase: "error"; progress: StageProgress[]; message: string };

export type AutoOutcome = Extract<AutoState, { phase: "done" | "error" }>;

/** Runs automatic detection for a plan and follows its real, streamed progress. */
export function useAutoInterpret() {
  const [state, setState] = useState<AutoState>({ phase: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const run = useCallback(async (planId: string): Promise<AutoOutcome | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let progress = initialProgress();
    let outcome: AutoOutcome | null = null;
    setState({ phase: "running", progress });

    try {
      await api.interpret(planId, (msg) => {
        if (msg.type === "stage") {
          progress = applyStage(progress, msg);
          setState({ phase: "running", progress });
        } else if (msg.type === "error") {
          outcome = { phase: "error", progress, message: msg.message };
        } else {
          const accepted = acceptInterpretation(msg.interpretation, planId);
          outcome = accepted.ok
            ? { phase: "done", progress: progress.map((s) => ({ ...s, status: "done" })), interpretation: accepted.interpretation, notes: accepted.notes }
            : { phase: "error", progress, message: accepted.message };
        }
      }, controller.signal);
      outcome ??= { phase: "error", progress, message: "The detector stopped before returning a result. Please try again." };
    } catch (err) {
      if (controller.signal.aborted) return null;
      outcome = { phase: "error", progress, message: err instanceof ApiError ? err.message : "Automatic detection failed." };
    }
    if (controller.signal.aborted) return null;
    setState(outcome);
    return outcome;
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState({ phase: "idle" });
  }, []);

  return { state, run, reset };
}
