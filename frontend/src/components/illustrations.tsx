/*
 * Locally drawn illustrations (inline SVG, no image files, no network). They show the idea of the product
 * — a 2D plan becoming a 3D model — using a small invented plan, never a real property.
 */

type Box = { x0: number; x1: number; y0: number; y1: number };
type Room = Box & { fill: string };

const T = 0.25; // wall thickness (plan units ≈ metres)
const H = 2.6; // wall height

/** Axis-aligned wall segments (gaps are doorways) of a small three-room plan, 12 × 8. */
const WALLS: Box[] = [
  { x0: 0, x1: 12, y0: 0, y1: T },
  { x0: 12 - T, x1: 12, y0: 0, y1: 8 },
  { x0: 0, x1: T, y0: 0, y1: 8 },
  { x0: 0, x1: 2, y0: 8 - T, y1: 8 },
  { x0: 3.2, x1: 12, y0: 8 - T, y1: 8 },
  { x0: 5 - T / 2, x1: 5 + T / 2, y0: 0, y1: 3 },
  { x0: 5 - T / 2, x1: 5 + T / 2, y0: 4, y1: 8 },
  { x0: 5, x1: 8, y0: 5 - T / 2, y1: 5 + T / 2 },
  { x0: 9, x1: 12, y0: 5 - T / 2, y1: 5 + T / 2 },
];
const ROOMS: Room[] = [
  { x0: 0, x1: 5, y0: 0, y1: 8, fill: "#e7d6bd" }, // timber
  { x0: 5, x1: 12, y0: 0, y1: 5, fill: "#ecdfca" },
  { x0: 5, x1: 12, y0: 5, y1: 8, fill: "#dfe6dc" }, // tile, sage tint
];

const C = Math.cos(Math.PI / 6), S = 0.5;
const pts = (list: [number, number][]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

function Axonometric({ ox, oy, k }: { ox: number; oy: number; k: number }) {
  const P = (x: number, y: number, z = 0): [number, number] => [ox + (x - y) * C * k, oy + (x + y) * S * k - z * k];
  // Painter's order: walls farther from the viewer (smaller x + y) first.
  const walls = [...WALLS].sort((a, b) => a.x1 + a.y1 + a.x0 + a.y0 - (b.x1 + b.y1 + b.x0 + b.y0));
  return (
    <g>
      <ellipse cx={P(6, 4)[0]} cy={P(6, 4)[1] + 0.6 * k} rx={9.5 * k} ry={3.6 * k} fill="var(--sage)" opacity="0.16" />
      {ROOMS.map((r, i) => (
        <polygon key={i} points={pts([P(r.x0, r.y0), P(r.x1, r.y0), P(r.x1, r.y1), P(r.x0, r.y1)])} fill={r.fill} />
      ))}
      {walls.map((w, i) => (
        <g key={i} stroke="#22261f" strokeOpacity="0.18" strokeWidth="0.6" strokeLinejoin="round">
          <polygon points={pts([P(w.x1, w.y0), P(w.x1, w.y1), P(w.x1, w.y1, H), P(w.x1, w.y0, H)])} fill="#e6dfd2" />
          <polygon points={pts([P(w.x0, w.y1), P(w.x1, w.y1), P(w.x1, w.y1, H), P(w.x0, w.y1, H)])} fill="#f7f3eb" />
          <polygon points={pts([P(w.x0, w.y0, H), P(w.x1, w.y0, H), P(w.x1, w.y1, H), P(w.x0, w.y1, H)])} fill="#2b302a" />
        </g>
      ))}
    </g>
  );
}

function PlanLines({ ox, oy, k, dashed = false }: { ox: number; oy: number; k: number; dashed?: boolean }) {
  return (
    <g>
      {!dashed && ROOMS.map((r, i) => (
        <rect key={i} x={ox + r.x0 * k} y={oy + r.y0 * k} width={(r.x1 - r.x0) * k} height={(r.y1 - r.y0) * k} fill={r.fill} opacity="0.55" />
      ))}
      {WALLS.map((w, i) => (
        <rect key={i} x={ox + w.x0 * k} y={oy + w.y0 * k} width={(w.x1 - w.x0) * k} height={(w.y1 - w.y0) * k}
          fill={dashed ? "none" : "#22261f"} stroke={dashed ? "var(--muted)" : "none"} strokeDasharray={dashed ? "3 3" : undefined} strokeWidth="1" />
      ))}
      {/* door swing at the entrance */}
      <path d={`M ${ox + 2 * k} ${oy + 8 * k} A ${1.2 * k} ${1.2 * k} 0 0 0 ${ox + 3.2 * k} ${oy + 6.8 * k}`} fill="none"
        stroke={dashed ? "var(--muted)" : "#22261f"} strokeWidth="0.8" strokeOpacity="0.7" />
    </g>
  );
}

/** Hero illustration: a drafting sheet with the plan, and the same plan as a 3D model. */
export function PlanToModelIllustration({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 560 400" className={className} role="img" aria-label="Illustration: a 2D floor plan turned into a 3D model">
      <defs>
        <pattern id="af-grid" width="12" height="12" patternUnits="userSpaceOnUse">
          <path d="M12 0H0V12" fill="none" stroke="var(--accent)" strokeOpacity="0.07" strokeWidth="1" />
        </pattern>
      </defs>
      <g>
        <rect x="14" y="20" width="262" height="196" rx="6" fill="#fdfbf6" stroke="var(--border)" />
        <rect x="14" y="20" width="262" height="196" rx="6" fill="url(#af-grid)" />
        <PlanLines ox={37} oy={46} k={18} />
        {/* dimension line */}
        <g stroke="var(--muted)" strokeWidth="0.8">
          <path d="M37 34h216M37 30v8M253 30v8" />
        </g>
        <text x="145" y="29" textAnchor="middle" fontSize="9" fill="var(--muted)" fontFamily="var(--font-geist-mono), monospace">12.00</text>
        <text x="28" y="206" fontSize="9" fill="var(--muted)" fontFamily="var(--font-geist-sans), sans-serif" letterSpacing="0.06em">PLAN</text>
      </g>
      <Axonometric ox={352} oy={186} k={17} />
    </svg>
  );
}

/** Small, quiet sketch for empty states: an outline plan waiting to be drawn. */
export function EmptyPlanSketch({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 170" className={className} aria-hidden>
      <defs>
        <pattern id="af-grid-sm" width="10" height="10" patternUnits="userSpaceOnUse">
          <path d="M10 0H0V10" fill="none" stroke="var(--accent)" strokeOpacity="0.07" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x="4" y="4" width="232" height="162" rx="8" fill="#fdfbf6" stroke="var(--border)" />
      <rect x="4" y="4" width="232" height="162" rx="8" fill="url(#af-grid-sm)" />
      <PlanLines ox={36} oy={25} k={14} dashed />
    </svg>
  );
}
