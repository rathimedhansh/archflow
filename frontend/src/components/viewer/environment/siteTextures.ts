import * as THREE from "three";
import { rng } from "@/lib/viewer/random";

/**
 * Ground materials for the illustrative surroundings, drawn on a canvas at runtime: no image
 * files, no network. Seeded (identical pixels on every load) and seamless; `metres` is the real
 * size one tile covers (the site geometry's UVs are world metres).
 */

export type SiteTextureKey = "grass" | "asphalt" | "concrete" | "pavers" | "mulch";

const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h}, ${s}%, ${l}%, ${a})`;

/** Draw `fn` at the 9 wrapped positions, so marks crossing an edge continue on the other side. */
function wrapped(size: number, fn: (dx: number, dy: number) => void) {
  for (const dx of [-size, 0, size]) for (const dy of [-size, 0, size]) fn(dx, dy);
}

/** A soft-edged colour patch, wrapped: hard-edged discs read as a repeating spot pattern up close. */
function softPatch(ctx: CanvasRenderingContext2D, size: number, x: number, y: number, rad: number, h: number, s: number, l: number, a: number) {
  wrapped(size, (dx, dy) => {
    const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, rad);
    g.addColorStop(0, hsl(h, s, l, a));
    g.addColorStop(1, hsl(h, s, l, 0));
    ctx.fillStyle = g;
    ctx.fillRect(x + dx - rad, y + dy - rad, rad * 2, rad * 2);
  });
}

/** Mown lawn: mottled base, then thousands of short blade strokes in close greens. */
function drawGrass(ctx: CanvasRenderingContext2D, size: number) {
  const r = rng(5);
  ctx.fillStyle = hsl(94, 25, 30);
  ctx.fillRect(0, 0, size, size);
  for (let k = 0; k < 60; k++) {
    const x = r() * size, y = r() * size, rad = size * (0.05 + r() * 0.12);
    softPatch(ctx, size, x, y, rad, 88 + r() * 20, 18 + r() * 10, 23 + r() * 10, 0.16);
  }
  ctx.lineCap = "round";
  for (let k = 0; k < 9000; k++) {
    const x = r() * size, y = r() * size;
    const len = 2 + r() * 4, a = -Math.PI / 2 + (r() - 0.5) * 1.4;
    const light = r();
    ctx.strokeStyle = hsl(84 + r() * 26, 20 + r() * 14, 21 + light * 22, 0.5);
    ctx.lineWidth = 0.6 + r() * 0.7;
    const ex = Math.cos(a) * len, ey = Math.sin(a) * len;
    if (x < 8 || y < 8 || x > size - 8 || y > size - 8) {
      wrapped(size, (dx, dy) => {
        ctx.beginPath(); ctx.moveTo(x + dx, y + dy); ctx.lineTo(x + dx + ex, y + dy + ey); ctx.stroke();
      });
    } else {
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + ex, y + ey); ctx.stroke();
    }
  }
}

/** Asphalt: dark grey with light and dark aggregate and faint wear patches. */
function drawAsphalt(ctx: CanvasRenderingContext2D, size: number) {
  const r = rng(9);
  ctx.fillStyle = hsl(220, 4, 30);
  ctx.fillRect(0, 0, size, size);
  for (let k = 0; k < 40; k++) {
    const x = r() * size, y = r() * size, rad = size * (0.06 + r() * 0.16);
    softPatch(ctx, size, x, y, rad, 215, 4, 26 + r() * 10, 0.14);
  }
  for (let k = 0; k < 14000; k++) {
    const x = r() * size, y = r() * size, s = 0.6 + r() * 1.6;
    ctx.fillStyle = r() < 0.5 ? hsl(30, 5, 42 + r() * 18, 0.55) : hsl(220, 6, 16 + r() * 8, 0.6);
    ctx.fillRect(x, y, s, s);
  }
}

/** Broom-finished concrete slabs, 2 × 2 per tile, with tooled joints. */
function drawConcrete(ctx: CanvasRenderingContext2D, size: number) {
  const r = rng(13);
  ctx.fillStyle = hsl(36, 5, 69);
  ctx.fillRect(0, 0, size, size);
  for (let k = 0; k < 70; k++) {
    const x = r() * size, y = r() * size, rad = size * (0.04 + r() * 0.12);
    softPatch(ctx, size, x, y, rad, 34, 5, 66 + r() * 14, 0.12);
  }
  for (let k = 0; k < 6000; k++) {
    ctx.fillStyle = hsl(30, 4, 55 + r() * 35, 0.2);
    ctx.fillRect(r() * size, r() * size, 0.6 + r() * 2.4, 0.6);
  }
  ctx.fillStyle = hsl(30, 5, 54, 0.75);
  const g = 2.2, half = size / 2;
  for (const t of [0, half, size]) {
    ctx.fillRect(t - g / 2, 0, g, size);
    ctx.fillRect(0, t - g / 2, size, g);
  }
}

/** Clay-tone concrete pavers in a running bond, with sand joints. */
function drawPavers(ctx: CanvasRenderingContext2D, size: number) {
  const r = rng(17);
  ctx.fillStyle = hsl(32, 10, 52);
  ctx.fillRect(0, 0, size, size);
  const rows = 8, cols = 4;
  const h = size / rows, w = size / cols;
  for (let row = 0; row < rows; row++) {
    const off = row % 2 ? w / 2 : 0;
    for (let c = -1; c < cols; c++) {
      const x = c * w + off;
      ctx.fillStyle = hsl(30 + r() * 6, 9 + r() * 5, 60 + r() * 6);
      ctx.fillRect(x + 1.2, row * h + 1.2, w - 2.4, h - 2.4);
      for (let k = 0; k < 18; k++) {
        ctx.fillStyle = hsl(30, 8, 45 + r() * 25, 0.25);
        ctx.fillRect(x + 2 + r() * (w - 6), row * h + 2 + r() * (h - 6), 1.5, 1.5);
      }
    }
  }
}

/** Bark mulch: dark brown with scattered chips. */
function drawMulch(ctx: CanvasRenderingContext2D, size: number) {
  const r = rng(19);
  ctx.fillStyle = hsl(24, 24, 21);
  ctx.fillRect(0, 0, size, size);
  for (let k = 0; k < 2600; k++) {
    const x = r() * size, y = r() * size;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(r() * Math.PI);
    ctx.fillStyle = hsl(20 + r() * 16, 20 + r() * 16, 16 + r() * 22, 0.85);
    ctx.fillRect(-2, -0.8, 2 + r() * 4, 1.2 + r() * 1.4);
    ctx.restore();
  }
}

const SPECS: Record<SiteTextureKey, { size: number; metres: number; draw: (ctx: CanvasRenderingContext2D, size: number) => void }> = {
  grass: { size: 512, metres: 2.5, draw: drawGrass },
  asphalt: { size: 512, metres: 3, draw: drawAsphalt },
  concrete: { size: 512, metres: 3, draw: drawConcrete },
  pavers: { size: 256, metres: 1.2, draw: drawPavers },
  mulch: { size: 256, metres: 1.2, draw: drawMulch },
};

export function createSiteTexture(key: SiteTextureKey): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const spec = SPECS[key];
  const c = document.createElement("canvas");
  c.width = c.height = spec.size;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  spec.draw(ctx, spec.size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / spec.metres, 1 / spec.metres);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8; // clamped to what the GPU supports; keeps the ground crisp at grazing angles
  return tex;
}

/** Soft round contact shadow (alpha), laid under each plant instead of real shadow casting. */
export function createBlobTexture(): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  // Grey levels, not alpha: three.js reads an alphaMap from its green channel.
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.45, "#999999");
  g.addColorStop(1, "#000000");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
