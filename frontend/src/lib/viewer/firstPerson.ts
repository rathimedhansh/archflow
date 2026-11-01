/**
 * First-person look (walk-through and VR only; the orbit view never uses any of this): the daylight
 * sky seen through windows and doors, the haze the surroundings fade into, and contact shading
 * where walls meet the floor and the ceiling. Pure numbers, shared by the renderer and its tests.
 */

/** Sky colours (sRGB) by elevation: soft blue overhead, pale haze at the horizon and below it. */
export const SKY = {
  zenith: "#8fb2d6",
  upper: "#b9d0e6",
  horizon: "#e9eef1",
  below: "#e4e6e1",
} as const;

/**
 * The colour the outdoor ground fades into in first person: the sky's horizon colour, so the
 * ground meets the sky without a seam (the orbit view keeps fading into its studio backdrop).
 */
export const HAZE = SKY.horizon;

/** Elevation in [-1, 1] (sin of the angle above the horizon) -> mix of two sky colours. */
export function skyStop(elevation: number): { from: keyof typeof SKY; to: keyof typeof SKY; t: number } {
  const e = Math.max(-1, Math.min(1, Number.isFinite(elevation) ? elevation : 0));
  if (e < 0) return { from: "horizon", to: "below", t: Math.min(1, -e / 0.15) };
  if (e < 0.35) return { from: "horizon", to: "upper", t: e / 0.35 };
  return { from: "upper", to: "zenith", t: (e - 0.35) / 0.65 };
}

/**
 * Contact shading on walls (a cheap stand-in for ambient occlusion, not global illumination):
 * walls get slightly darker within ~0.4 m of the floor and ~0.3 m of the ceiling, where real
 * corners receive less bounced light. Returns the factor the wall colour is multiplied by.
 */
export const CONTACT = { floorDepth: 0.22, floorReach: 0.4, ceilingDepth: 0.14, ceilingReach: 0.3 } as const;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function contactShade(y: number, top: number): number {
  if (!Number.isFinite(y) || !Number.isFinite(top)) return 1;
  const floor = CONTACT.floorDepth * (1 - smoothstep(0, CONTACT.floorReach, y));
  const ceiling = CONTACT.ceilingDepth * (1 - smoothstep(0, CONTACT.ceilingReach, top - y));
  return 1 - floor - ceiling;
}

/** The same formula as GLSL (kept next to the TypeScript version so they cannot drift apart). */
export const CONTACT_GLSL = `
float archflowContact( float y, float top ) {
  float f = ${CONTACT.floorDepth.toFixed(3)} * ( 1.0 - smoothstep( 0.0, ${CONTACT.floorReach.toFixed(3)}, y ) );
  float c = ${CONTACT.ceilingDepth.toFixed(3)} * ( 1.0 - smoothstep( 0.0, ${CONTACT.ceilingReach.toFixed(3)}, top - y ) );
  return 1.0 - f - c;
}`;
