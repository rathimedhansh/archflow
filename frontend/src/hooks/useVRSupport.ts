"use client";

import { useEffect, useState } from "react";
import { detectVRSupport, type VRSupport } from "@/lib/vr/support";

/**
 * Whether this browser can open an immersive VR session. Re-checked when a headset is
 * connected or disconnected (`devicechange`), so the button appears without a reload.
 */
export function useVRSupport(): VRSupport {
  const [support, setSupport] = useState<VRSupport>("checking");
  useEffect(() => {
    let cancelled = false;
    const check = () =>
      void detectVRSupport({ isSecureContext: window.isSecureContext, xr: navigator.xr }).then((s) => {
        if (!cancelled) setSupport(s);
      });
    check();
    const xr = navigator.xr;
    xr?.addEventListener?.("devicechange", check);
    return () => {
      cancelled = true;
      xr?.removeEventListener?.("devicechange", check);
    };
  }, []);
  return support;
}
