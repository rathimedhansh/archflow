import { describe, expect, it } from "vitest";
import { createSiteFade } from "../../components/viewer/environment/siteFade";
import { wallTopAttribute } from "../../components/viewer/toBufferGeometry";
import type { FloorPlanData } from "@/lib/floorplan/types";
import { buildScene } from "../geometry3d/buildScene";
import { sceneFingerprint } from "../geometry3d/fingerprint";
import { CONTACT, CONTACT_GLSL, contactShade, HAZE, SKY, skyStop } from "./firstPerson";

describe("first-person sky", () => {
  it("runs from haze at the horizon to blue overhead, haze below", () => {
    expect(skyStop(0)).toEqual({ from: "horizon", to: "upper", t: 0 });
    expect(skyStop(1)).toEqual({ from: "upper", to: "zenith", t: 1 });
    expect(skyStop(-1)).toEqual({ from: "horizon", to: "below", t: 1 });
    // Continuous at the band edges.
    expect(skyStop(0.35 - 1e-9).t).toBeCloseTo(1, 6);
    expect(skyStop(0.35).t).toBe(0);
    expect(skyStop(NaN)).toEqual(skyStop(0));
  });

  it("the ground fades into exactly the sky's horizon colour (no seam)", () => {
    expect(HAZE).toBe(SKY.horizon);
  });

  it("switching the fade to haze and back restores the orbit colours exactly", () => {
    const fade = createSiteFade();
    const before = [fade.uniforms.siteTop.value.clone(), fade.uniforms.siteMid.value.clone(), fade.uniforms.siteBottom.value.clone()];
    fade.setHaze(HAZE);
    expect(fade.uniforms.siteTop.value.equals(fade.uniforms.siteBottom.value)).toBe(true);
    expect(fade.uniforms.siteTop.value.equals(before[0])).toBe(false);
    fade.setHaze(null);
    expect([fade.uniforms.siteTop.value, fade.uniforms.siteMid.value, fade.uniforms.siteBottom.value].every((v, i) => v.equals(before[i]))).toBe(true);
  });
});

describe("contact shading on walls (first person only)", () => {
  it("darkens near the floor and the ceiling, not in between", () => {
    expect(contactShade(0, 2.7)).toBeCloseTo(1 - CONTACT.floorDepth, 9);
    expect(contactShade(2.7, 2.7)).toBeCloseTo(1 - CONTACT.ceilingDepth, 9);
    expect(contactShade(1.35, 2.7)).toBe(1);
    expect(contactShade(CONTACT.floorReach, 2.7)).toBe(1);
    // Monotonic: brighter as one moves away from the floor.
    expect(contactShade(0.1, 2.7)).toBeLessThan(contactShade(0.2, 2.7));
  });

  it("stays subtle and safe", () => {
    for (let y = 0; y <= 2.7; y += 0.05) {
      const k = contactShade(y, 2.7);
      expect(k).toBeGreaterThanOrEqual(1 - CONTACT.floorDepth - CONTACT.ceilingDepth);
      expect(k).toBeLessThanOrEqual(1);
    }
    expect(contactShade(NaN, 2.7)).toBe(1);
  });

  it("the shader uses the same constants", () => {
    for (const v of Object.values(CONTACT)) expect(CONTACT_GLSL).toContain(v.toFixed(3));
  });

  it("each wall vertex carries its wall's top height; the engine output is untouched", () => {
    const plan: FloorPlanData = {
      version: 1, units: "meters", provenance: "manual",
      source: { floorplan_id: "a".repeat(32), width_px: 500, height_px: 500 }, scale: { meters_per_pixel: 0.01, calibrated: true },
      walls: [{ id: "w", start: [0, 0], end: [4, 0], height: 2.6, thickness: 0.2 }, { id: "v", start: [0, 0], end: [0, 3], height: 3.1, thickness: 0.2 }],
      rooms: [], doors: [{ id: "d", wall_id: "w", offset: 1, width: 0.9, height: 2.1 }], windows: [],
    };
    const scene = buildScene(plan);
    const fp = sceneFingerprint(scene);
    for (const o of scene.objects.filter((x) => x.kind === "wall")) {
      const tops = wallTopAttribute(o.mesh);
      expect(tops.length).toBe(o.mesh.positions.length / 3);
      expect(new Set(tops).size).toBe(1);
      expect(tops[0]).toBeCloseTo(o.sourceId === "w" ? 2.6 : 3.1, 5);
    }
    expect(sceneFingerprint(scene)).toBe(fp);
  });
});
