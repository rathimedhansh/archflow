/**
 * Can this browser show the property in a VR headset? Decided only from the standard WebXR
 * API (`navigator.xr.isSessionSupported("immersive-vr")`); no user-agent sniffing.
 */

export type VRSupport = "checking" | "supported" | "unsupported" | "no-webxr" | "insecure" | "error";

/** The slice of the browser this module needs, so it can be tested without one. */
export interface XREnv {
  isSecureContext: boolean;
  xr?: { isSessionSupported: (mode: "immersive-vr") => Promise<boolean> } | null;
}

export async function detectVRSupport(env: XREnv): Promise<Exclude<VRSupport, "checking">> {
  // WebXR only exists on secure pages (HTTPS, or localhost during development).
  if (!env.isSecureContext) return "insecure";
  if (!env.xr || typeof env.xr.isSessionSupported !== "function") return "no-webxr";
  try {
    return (await env.xr.isSessionSupported("immersive-vr")) ? "supported" : "unsupported";
  } catch {
    // e.g. blocked by a permissions policy
    return "error";
  }
}

/** Plain-language explanation shown to the visitor when VR cannot start here. */
export function supportMessage(s: VRSupport): string {
  switch (s) {
    case "checking":
      return "Checking whether this device can show VR…";
    case "supported":
      return "A VR headset is available. Put it on after pressing Enter VR.";
    case "insecure":
      return "VR needs a secure (https://) page. Open this property over HTTPS to view it in a headset.";
    case "no-webxr":
      return "This browser does not support WebXR, so VR is not available here. The 3D view works as usual.";
    case "unsupported":
      return "No VR headset was found for this browser. The 3D view works as usual.";
    case "error":
      return "This page is not allowed to use VR (WebXR is blocked). The 3D view works as usual.";
  }
}

export const VR_HOW_TO =
  "To walk through in VR, open this page in the browser of a standalone headset (e.g. Meta Quest Browser), " +
  "or in Chrome or Edge on a PC with a connected VR headset.";

export const VR_NO_START =
  "There is no safe place to start in this model (every candidate point is inside or against a wall), so VR was not started.";

/** UI state of a VR visit, driven by the session's real events. */
export type VRPhase = "idle" | "starting" | "active";
export interface VRStatus {
  phase: VRPhase;
  error: string | null;
}
export type VRAction =
  | { type: "request" }
  | { type: "started" }
  | { type: "ended" }
  | { type: "failed"; message: string }
  | { type: "dismiss" };

export const initialVRStatus: VRStatus = { phase: "idle", error: null };

export function vrReducer(s: VRStatus, a: VRAction): VRStatus {
  switch (a.type) {
    case "request":
      return s.phase === "idle" ? { phase: "starting", error: null } : s;
    case "started":
      return { phase: "active", error: null };
    case "ended":
      return { phase: "idle", error: s.error };
    case "failed":
      return { phase: "idle", error: a.message };
    case "dismiss":
      return { ...s, error: null };
  }
}

/** Readable reason for a failed `requestSession`. */
export function describeVRError(e: unknown): string {
  const name = e instanceof Error || (typeof e === "object" && e !== null && "name" in e) ? String((e as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "The browser did not allow VR to start. Try again, and accept the headset prompt if one appears.";
  if (name === "NotSupportedError") return "This headset or browser cannot start an immersive VR session.";
  if (name === "InvalidStateError") return "Another VR session is already running. Close it and try again.";
  return "VR could not be started on this device.";
}
