import { describe, expect, it } from "vitest";
import type { PlanSummary, Project } from "../api";
import { cleanProjectFields, LIMITS, nextAction, projectStage, projectSteps, shareUrl, timeAgo } from "./status";
import { initialTour, stopCaption, tourReducer, tourStops, type TourState } from "../viewer/tour";

const plan = (over: Partial<PlanSummary> = {}): PlanSummary => ({
  saved: true, saved_at: "2026-09-27T10:00:00+00:00", damaged: false, auto_detected: true, provenance: "opencv",
  calibrated: true, walls: 12, rooms: 5, doors: 4, windows: 6, floor_area_m2: 84.5, ...over,
});

const project = (over: Partial<Project> = {}): Project => ({
  id: "p".repeat(32), name: "Harbour View", address: "", description: "",
  created_at: "2026-09-27T09:00:00+00:00", updated_at: "2026-09-27T09:00:00+00:00",
  floorplan: { id: "f".repeat(32), original_filename: "plan.png", width: 1000, height: 800, image_url: "/api/floorplans/f/image" },
  plan: plan(), share: null, ...over,
});

const share = (up_to_date = true) => ({ token: "t".repeat(24), url_path: `/share/${"t".repeat(24)}`, published_at: "2026-09-27T11:00:00+00:00", up_to_date });

describe("projectStage", () => {
  it.each([
    ["new: no floor plan", project({ floorplan: null, plan: null }), "new"],
    ["uploaded: nothing saved yet", project({ plan: plan({ saved: false, walls: 0, rooms: 0 }) }), "uploaded"],
    ["draft: saved but not calibrated", project({ plan: plan({ calibrated: false }) }), "draft"],
    ["draft: saved but empty", project({ plan: plan({ walls: 0, rooms: 0 }) }), "draft"],
    ["ready: saved, calibrated, not shared", project(), "ready"],
    ["shared", project({ share: share() }), "shared"],
    ["damaged beats everything", project({ plan: plan({ damaged: true }), share: share() }), "damaged"],
  ])("%s", (_, p, stage) => expect(projectStage(p)).toBe(stage));
});

describe("projectSteps and nextAction", () => {
  it("walks the developer through upload → review → calibrate → share", () => {
    const fresh = project({ floorplan: null, plan: null });
    expect(projectSteps(fresh).map((s) => s.done)).toEqual([false, false, false, false]);
    expect(nextAction(fresh)).toEqual({ label: "Upload floor plan", action: "upload" });

    const detected = project({ plan: plan({ saved: false, walls: 0, rooms: 0 }) });
    expect(projectSteps(detected).map((s) => s.done)).toEqual([true, false, false, false]);
    expect(nextAction(detected).href).toBe(`/plans/${"f".repeat(32)}/edit?source=auto`);
    expect(nextAction(project({ plan: plan({ saved: false, auto_detected: false, walls: 0, rooms: 0 }) })).href).toBe(`/plans/${"f".repeat(32)}/edit`);

    const uncalibrated = project({ plan: plan({ calibrated: false }) });
    expect(projectSteps(uncalibrated).map((s) => s.done)).toEqual([true, true, false, false]);
    expect(nextAction(uncalibrated).label).toBe("Set the scale");

    expect(nextAction(project())).toEqual({ label: "Publish buyer page", action: "publish" });
    const shared = project({ share: share() });
    expect(projectSteps(shared).every((s) => s.done)).toBe(true);
    expect(nextAction(shared)).toEqual({ label: "Open buyer page", href: share().url_path });

    const stale = project({ share: share(false) });
    expect(projectSteps(stale)[3]).toMatchObject({ done: false, detail: expect.stringMatching(/changed since publishing/) });
    expect(nextAction(stale)).toEqual({ label: "Update buyer page", action: "publish" });
  });

  it("does not count a damaged or empty saved plan as reviewed", () => {
    expect(projectSteps(project({ plan: plan({ damaged: true }) }))[1].done).toBe(false);
    expect(projectSteps(project({ plan: plan({ walls: 0, rooms: 0 }) }))[1].done).toBe(false);
    expect(nextAction(project({ plan: plan({ damaged: true }) })).action).toBe("upload");
  });
});

describe("cleanProjectFields", () => {
  it("collapses whitespace like the backend and requires a name", () => {
    const { value, errors } = cleanProjectFields({ name: "  Harbour \n View ", address: " 12  Quay St ", description: "  Two lines\nkept  " });
    expect(value).toEqual({ name: "Harbour View", address: "12 Quay St", description: "Two lines\nkept" });
    expect(errors).toEqual({});
    expect(cleanProjectFields({ name: "   " }).errors.name).toMatch(/name/);
  });
  it("enforces the length limits", () => {
    const { errors } = cleanProjectFields({ name: "x".repeat(LIMITS.name + 1), address: "a".repeat(LIMITS.address + 1), description: "d".repeat(LIMITS.description + 1) });
    expect(Object.keys(errors).sort()).toEqual(["address", "description", "name"]);
  });
});

describe("share helpers", () => {
  it("builds absolute buyer links", () => {
    expect(shareUrl("http://localhost:3000", "/share/abc")).toBe("http://localhost:3000/share/abc");
    expect(shareUrl("https://example.com/", "share/abc")).toBe("https://example.com/share/abc");
  });
  it("describes times in plain words", () => {
    const now = Date.parse("2026-09-27T12:00:00Z");
    expect(timeAgo("2026-09-27T11:59:30Z", now)).toBe("just now");
    expect(timeAgo("2026-09-27T11:45:00Z", now)).toBe("15 min ago");
    expect(timeAgo("2026-09-27T09:00:00Z", now)).toBe("3 h ago");
    expect(timeAgo("2026-09-26T11:00:00Z", now)).toBe("1 day ago");
    expect(timeAgo("2026-09-24T11:00:00Z", now)).toBe("3 days ago");
    expect(timeAgo("2026-08-01T11:00:00Z", now)).toBe("2026-08-01");
    expect(timeAgo("not a date", now)).toBe("unknown");
    expect(timeAgo(null, now)).toBe("unknown");
  });
});

describe("presentation tour", () => {
  const spaces = [{ id: "r1", name: "Living", area: 24.25 }, { id: "r2", name: "Kitchen", area: 9.6 }];
  const stops = tourStops(spaces);
  const run = (actions: Parameters<typeof tourReducer>[1][], start: TourState = initialTour()) =>
    actions.reduce((s, a) => tourReducer(s, a, stops.length), start);

  it("starts with an overview, then every room in plan order", () => {
    expect(stops.map((s) => (s.kind === "overview" ? "overview" : s.id))).toEqual(["overview", "r1", "r2"]);
    expect(stopCaption(stops[1], true)).toBe("Living · 24.3 m²");
    expect(stopCaption(stops[2], false)).toBe("Kitchen · ≈ 9.6 m²");
    expect(stopCaption(stops[0], true)).toBe("Overview");
  });

  it("steps forward and back without leaving the tour", () => {
    expect(run([{ type: "next" }]).index).toBe(1);
    expect(run([{ type: "next" }, { type: "next" }, { type: "next" }]).index).toBe(2);
    expect(run([{ type: "prev" }]).index).toBe(0);
    expect(run([{ type: "goto", index: 99 }]).index).toBe(2);
    expect(run([{ type: "goto", index: Number.NaN }]).index).toBe(0);
  });

  it("autoplay advances only while playing and loops back to the overview", () => {
    expect(run([{ type: "tick" }]).index).toBe(0);
    const playing = run([{ type: "play" }, { type: "tick" }, { type: "tick" }]);
    expect(playing).toEqual({ index: 2, playing: true });
    expect(run([{ type: "tick" }], playing).index).toBe(0);
    expect(run([{ type: "toggle" }], playing).playing).toBe(false);
  });

  it("a plan without rooms has only the overview, and cannot autoplay", () => {
    const only = tourStops([]);
    expect(only).toEqual([{ kind: "overview" }]);
    expect(tourReducer(initialTour(), { type: "play" }, only.length)).toEqual({ index: 0, playing: false });
    expect(tourReducer(initialTour(), { type: "next" }, only.length).index).toBe(0);
  });
});
