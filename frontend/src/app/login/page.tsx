"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import SiteHeader from "@/components/SiteHeader";
import { button, fieldInput, fieldLabel, Loading, Notice, pageWidth, Panel, Spinner } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { DEFAULT_AFTER_LOGIN, safeNextPath } from "@/lib/auth";

type State = "checking" | "form" | "not-required" | "offline";

/** Developer sign-in. The password is set by whoever runs the server (README "Sign-in"). */
export default function LoginPage() {
  const [state, setState] = useState<State>("checking");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read on the client (no Suspense boundary needed); only same-site paths are accepted.
  const [next] = useState(() =>
    typeof window === "undefined" ? DEFAULT_AFTER_LOGIN : safeNextPath(new URLSearchParams(window.location.search).get("next")),
  );

  useEffect(() => {
    document.title = "Sign in · ARCHFLOW";
    let cancelled = false;
    api
      .authStatus()
      .then((s) => {
        if (cancelled) return;
        if (!s.auth_enabled) setState("not-required");
        else if (s.authenticated) window.location.replace(next);
        else setState("form");
      })
      .catch(() => !cancelled && setState("offline"));
    return () => {
      cancelled = true;
    };
  }, [next]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      // A full navigation, so every page starts with the new session.
      window.location.replace(next);
    } catch (err) {
      setBusy(false);
      setPassword("");
      setError(err instanceof ApiError ? err.message : "Sign-in failed. Please try again.");
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className={`${pageWidth} flex flex-1 flex-col items-center pb-24 pt-12 sm:pt-20`}>
        <div className="w-full max-w-sm">
          <p className="eyebrow">Developers</p>
          <h1 className="mt-3 font-display text-[2rem] font-medium leading-tight">Sign in</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-muted">
            Managing properties needs the developer password. Buyer links work without signing in.
          </p>

          <Panel className="mt-8">
            {state === "checking" && <Loading>Checking…</Loading>}

            {state === "offline" && (
              <Notice tone="danger" title="The ARCHFLOW engine cannot be reached">
                Signing in needs the backend. Try again in a moment.
              </Notice>
            )}

            {state === "not-required" && (
              <div data-testid="login-not-required">
                <Notice title="Sign-in is not required on this server">
                  It runs without a developer password (local development).
                </Notice>
                <Link href={next} className={button("primary", "md", "mt-5 w-full")}>Continue</Link>
              </div>
            )}

            {state === "form" && (
              <form onSubmit={submit} noValidate data-testid="login-form">
                <label className={fieldLabel}>
                  Password
                  <input
                    type="password"
                    name="password"
                    autoComplete="current-password"
                    required
                    autoFocus
                    maxLength={1024}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-invalid={error ? true : undefined}
                    className={fieldInput}
                    data-testid="login-password"
                  />
                </label>
                {error && <Notice tone="danger" className="mt-4" testId="login-error">{error}</Notice>}
                <button type="submit" disabled={busy || !password} className={button("primary", "md", "mt-5 w-full")} data-testid="login-submit">
                  {busy && <Spinner />} {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>
            )}
          </Panel>
        </div>
      </main>
    </div>
  );
}
