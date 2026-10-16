"use client";

import { useCallback, useState } from "react";
import { api, ApiError, type FloorPlan } from "@/lib/api";
import { validateFloorPlanFile } from "@/lib/upload";

export type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; progress: number; fileName: string }
  /** Bytes are sent; the server is validating and normalizing the image. */
  | { phase: "processing"; fileName: string }
  | { phase: "ready"; plan: FloorPlan }
  | { phase: "error"; message: string };

export function useFloorPlanUpload() {
  const [state, setState] = useState<UploadState>({ phase: "idle" });

  /** Resolves with the stored plan, or null when the upload failed (the state explains why). */
  const upload = useCallback(async (file: File): Promise<FloorPlan | null> => {
    const problem = validateFloorPlanFile(file);
    if (problem) {
      setState({ phase: "error", message: problem });
      return null;
    }
    setState({ phase: "uploading", progress: 0, fileName: file.name });
    try {
      const plan = await api.uploadFloorPlan(file, (progress) => {
        setState(
          progress >= 1
            ? { phase: "processing", fileName: file.name }
            : { phase: "uploading", progress, fileName: file.name },
        );
      });
      setState({ phase: "ready", plan });
      return plan;
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Something went wrong. Please try again.";
      setState({ phase: "error", message });
      return null;
    }
  }, []);

  const reset = useCallback(() => setState({ phase: "idle" }), []);

  return { state, upload, reset };
}
