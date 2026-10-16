/**
 * Developer sign-in helpers (framework-free, unit tested).
 *
 * The backend keeps the session in an HttpOnly cookie; the frontend only has to send cookies,
 * add the CSRF header to state-changing requests and send people to /login when the API says 401.
 */

/** Must be on every POST/PUT/PATCH/DELETE when sign-in is on (the backend refuses writes without it). */
export const CSRF_HEADER = "X-ARCHFLOW-CSRF";

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const isUnsafeMethod = (method: string | undefined) => UNSAFE.has((method ?? "GET").toUpperCase());

export const DEFAULT_AFTER_LOGIN = "/projects";

/**
 * Where to go after signing in. Only same-site paths are accepted ("/projects/abc?x=1"), so a crafted
 * link cannot use the login page to send someone to another website.
 */
export function safeNextPath(next: string | null | undefined): string {
  if (!next || next.length > 2048) return DEFAULT_AFTER_LOGIN;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return DEFAULT_AFTER_LOGIN;
  // Control characters (incl. tab/newline) can make browsers read a path as something else.
  if (/[\u0000-\u001f\u007f]/.test(next)) return DEFAULT_AFTER_LOGIN;
  if (next === "/login" || next.startsWith("/login?") || next.startsWith("/login/")) return DEFAULT_AFTER_LOGIN;
  return next;
}

/** Pages that must never bounce to the login page: buyer links are public, and /login itself. */
export function isPublicPage(pathname: string): boolean {
  return pathname.startsWith("/share/") || pathname === "/login";
}

/** The login URL that brings the developer back to `pathname + search` afterwards. */
export function loginUrlFor(pathname: string, search = ""): string {
  const next = safeNextPath(`${pathname}${search}`);
  return next === DEFAULT_AFTER_LOGIN ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}

/** Fetch options with the session cookie and, for writes, the CSRF header. */
export function withAuth(init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  if (isUnsafeMethod(init.method)) headers.set(CSRF_HEADER, "1");
  return { ...init, credentials: "include", headers };
}
