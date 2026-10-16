import * as THREE from "three";
import type { FloorFinish } from "@/lib/viewer/floorFinish";

/**
 * Floor finishes and the studio backdrop, drawn on a canvas at runtime: no image files, no
 * network. Seeded, so every load draws identical pixels (the viewer's render is deterministic).
 * Each texture tiles seamlessly; `metres` is the real size one tile covers.
 */

/** mulberry32: small deterministic PRNG. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h}, ${s}%, ${l}%, ${a})`;

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d");
  return ctx ? [c, ctx] : null;
}

/** Light oak planks running along X: 12 rows of ~0.2 m, staggered butt joints, fine grain. */
function drawWood(ctx: CanvasRenderingContext2D, size: number) {
  const r = rng(11);
  const rows = 12;
  const h = size / rows;
  for (let row = 0; row < rows; row++) {
    const y = row * h;
    // Plank segments across the width; the last one wraps around so the tile is seamless.
    let x = r() * size;
    const start = x;
    while (x < start + size) {
      const len = Math.min(size * (0.35 + r() * 0.4), start + size - x);
      const l = 66 + r() * 7;
      const fill = hsl(32 + r() * 4, 34 + r() * 8, l);
      for (const dx of [0, -size]) {
        ctx.fillStyle = fill;
        ctx.fillRect(x + dx, y, len, h);
        // Grain: faint wavy streaks; whole sine periods per tile keep the edges matching.
        for (let g = 0; g < 7; g++) {
          const gy = y + 2 + r() * (h - 4);
          const amp = 0.6 + r() * 1.4;
          const k = 1 + Math.floor(r() * 3);
          ctx.strokeStyle = hsl(28, 30, l - 10 - r() * 8, 0.18 + r() * 0.15);
          ctx.lineWidth = 0.6 + r() * 0.8;
          ctx.beginPath();
          for (let px = 0; px <= len; px += 8) {
            const yy = gy + amp * Math.sin(((x + px) / size) * Math.PI * 2 * k);
            if (px === 0) ctx.moveTo(x + dx + px, yy);
            else ctx.lineTo(x + dx + px, yy);
          }
          ctx.stroke();
        }
        // Butt joint at the end of the plank.
        ctx.fillStyle = hsl(28, 25, 42, 0.55);
        ctx.fillRect(x + dx + len - 1, y, 1.2, h);
      }
      x += len;
    }
    // Long seam between rows.
    ctx.fillStyle = hsl(28, 25, 40, 0.5);
    ctx.fillRect(0, y, size, 1.2);
  }
}

/** Large light porcelain tiles: 2 × 2 per texture, faint mottling, soft grout lines. */
function drawTile(ctx: CanvasRenderingContext2D, size: number) {
  const r = rng(23);
  const n = 2;
  const t = size / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      ctx.fillStyle = hsl(36, 8 + r() * 4, 86 + r() * 3);
      ctx.fillRect(i * t, j * t, t, t);
      for (let k = 0; k < 260; k++) {
        ctx.fillStyle = hsl(30, 6, 70 + r() * 25, 0.08 + r() * 0.1);
        const s = 1 + r() * 3;
        ctx.fillRect(i * t + r() * (t - s), j * t + r() * (t - s), s, s);
      }
    }
  }
  // Grout centred on the tile edges; edges at 0 and `size` are drawn half on each side (seamless).
  ctx.fillStyle = hsl(30, 6, 74);
  const g = 3;
  for (let k = 0; k <= n; k++) {
    ctx.fillRect(k * t - g / 2, 0, g, size);
    ctx.fillRect(0, k * t - g / 2, size, g);
  }
}

/** Neutral: soft warm-grey resin/concrete with low-contrast clouding. Used for unknown rooms. */
function drawNeutral(ctx: CanvasRenderingContext2D, size: number) {
  const r = rng(37);
  ctx.fillStyle = hsl(36, 7, 80);
  ctx.fillRect(0, 0, size, size);
  for (let k = 0; k < 90; k++) {
    const x = r() * size;
    const y = r() * size;
    const rad = size * (0.04 + r() * 0.12);
    const fill = hsl(34, 6, 72 + r() * 16, 0.06 + r() * 0.06);
    // Drawn at every wrapped position so blotches crossing an edge continue on the other side.
    for (const dx of [-size, 0, size]) {
      for (const dy of [-size, 0, size]) {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(x + dx, y + dy, rad, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

const FINISHES: Record<FloorFinish, { size: number; metres: number; draw: (ctx: CanvasRenderingContext2D, size: number) => void }> = {
  wood: { size: 512, metres: 2.4, draw: drawWood },
  tile: { size: 512, metres: 1.2, draw: drawTile },
  neutral: { size: 256, metres: 2.0, draw: drawNeutral },
};

/** A seamless floor texture; UVs are world metres (see planarUVs), so repeat = 1 / metres. */
export function createFloorTexture(finish: FloorFinish): THREE.Texture | null {
  const spec = FINISHES[finish];
  const made = canvas(spec.size);
  if (!made) return null;
  const [c, ctx] = made;
  spec.draw(ctx, spec.size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / spec.metres, 1 / spec.metres);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4; // three.js clamps to what the GPU supports
  return tex;
}

/** Soft studio backdrop: a vertical gradient drawn behind the model, independent of the camera. */
export function createBackdropTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, "#dfe4ea");
  g.addColorStop(0.55, "#eef0f2");
  g.addColorStop(1, "#f7f6f3");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
