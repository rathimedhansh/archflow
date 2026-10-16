"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

/** "Sign out" in the header, shown only when the server uses sign-in and this browser is signed in. */
export default function AccountButton() {
  const router = useRouter();
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .authStatus()
      .then((s) => !cancelled && setSignedIn(s.auth_enabled && s.authenticated))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!signedIn) return null;
  return (
    <button
      type="button"
      disabled={busy}
      data-testid="sign-out"
      className="rounded-md px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-foreground disabled:opacity-60"
      onClick={async () => {
        setBusy(true);
        await api.logout().catch(() => {});
        router.push("/login");
      }}
    >
      Sign out
    </button>
  );
}
