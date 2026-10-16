import { describe, expect, it } from "vitest";
import { CSRF_HEADER, DEFAULT_AFTER_LOGIN, isPublicPage, isUnsafeMethod, loginUrlFor, safeNextPath, withAuth } from "./auth";

describe("safeNextPath", () => {
  it("keeps same-site paths with their query", () => {
    expect(safeNextPath("/projects")).toBe("/projects");
    expect(safeNextPath("/projects/abc")).toBe("/projects/abc");
    expect(safeNextPath("/plans/abc/view?present=1")).toBe("/plans/abc/view?present=1");
  });

  it.each([
    [null], [undefined], [""], ["projects"], ["//evil.example"], ["/\\evil.example"], ["https://evil.example"],
    ["javascript:alert(1)"], ["/%0a/evil".replace("%0a", "\n")], ["/\tevil"], ["/login"], ["/login?next=/x"],
    ["/" + "a".repeat(3000)],
  ])("refuses %j", (next) => {
    expect(safeNextPath(next as string | null | undefined)).toBe(DEFAULT_AFTER_LOGIN);
  });
});

describe("isPublicPage", () => {
  it("never sends buyers or the login page itself to sign in", () => {
    expect(isPublicPage("/share/abcDEF123_-")).toBe(true);
    expect(isPublicPage("/login")).toBe(true);
    expect(isPublicPage("/projects")).toBe(false);
    expect(isPublicPage("/plans/x/edit")).toBe(false);
    expect(isPublicPage("/shared")).toBe(false);
  });
});

describe("loginUrlFor", () => {
  it("returns to where the developer was", () => {
    expect(loginUrlFor("/projects/abc", "?tab=1")).toBe("/login?next=%2Fprojects%2Fabc%3Ftab%3D1");
    expect(loginUrlFor("/projects")).toBe("/login");
  });
});

describe("withAuth", () => {
  it("always sends cookies and adds the CSRF header to writes only", () => {
    for (const method of ["POST", "put", "PATCH", "DELETE"]) {
      const init = withAuth({ method });
      expect(init.credentials).toBe("include");
      expect(new Headers(init.headers).get(CSRF_HEADER)).toBe("1");
    }
    for (const method of [undefined, "GET", "HEAD"]) {
      const init = withAuth({ method });
      expect(init.credentials).toBe("include");
      expect(new Headers(init.headers).has(CSRF_HEADER)).toBe(false);
    }
  });

  it("keeps the caller's headers and options", () => {
    const init = withAuth({ method: "PUT", headers: { "Content-Type": "application/json" }, cache: "no-store", body: "{}" });
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get(CSRF_HEADER)).toBe("1");
    expect(init.cache).toBe("no-store");
    expect(init.body).toBe("{}");
  });

  it("knows which methods change state", () => {
    expect(isUnsafeMethod("post")).toBe(true);
    expect(isUnsafeMethod(undefined)).toBe(false);
    expect(isUnsafeMethod("OPTIONS")).toBe(false);
  });
});
