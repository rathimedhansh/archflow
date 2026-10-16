# ARCHFLOW frontend

Next.js 16 (App Router) + React 19 + TypeScript + Tailwind CSS 4, with React Three Fiber / three.js for the 3D viewer
and the WebXR walkthrough. Setup, running the whole app and the backend are described in the
[root README](../README.md); this file covers working on the frontend itself.

## Commands

| Command | What it does |
|---|---|
| `npm ci` | Install the exact dependency versions from `package-lock.json` |
| `npm run dev` | Development server on http://localhost:3000 (hot reload) |
| `npm run build` | Production build into `.next/` |
| `npm start` | Serve the production build on http://localhost:3000 |
| `npm test` | Unit tests (Vitest) |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | Type check (run after a build or `npm run dev`, which generate the route types) |

Requires Node.js 20.9 or newer (tested with 24.21.0). The backend must be running for anything beyond the landing page.

## Configuration

Copy `.env.local.example` to `.env.local`. It contains one setting, `NEXT_PUBLIC_API_URL` (default
`http://localhost:8000`). It is built into the bundle at `npm run build`, so rebuild after changing it.
`.env.local` is git-ignored.

## Layout

```
src/app/              routes: / · /projects · /projects/new · /projects/[id] · /plans/[id]/edit · /plans/[id]/view · /share/[token]
src/components/       ui.tsx (shared design kit), ConfirmDialog, illustrations, upload and detection steps
  editor/             2D floor-plan editor (SVG canvas, tools, review panel)
  projects/           property forms, upload flow, buyer-link panel
  viewer/             3D viewer (Viewer3D, PropertyViewer, panel, camera, room labels, presentation)
    environment/      illustrative surroundings (procedural, no external assets)
    vr/               WebXR session, HUD and in-headset labels
src/hooks/            React hooks (upload, automatic detection, fullscreen, VR support)
src/lib/              framework-free logic, unit tested
  api.ts, upload.ts   backend API client and upload rules
  floorplan/          FloorPlan types, geometry, editing operations, validation, undo history
  geometry3d/         FloorPlan -> 3D scene engine (walls, openings, rooms, triangulation)
  interpretation/     automatic-detection stream parsing and review items
  projects/           property status, checklist, form rules
  viewer/             framing, labels, layers, tour, environment layout
  vr/                 collision, navigation, WebXR support detection
```

Logic in `src/lib` imports nothing from React or three.js and is covered by the Vitest suite. Design tokens (colours,
fonts, focus and reduced-motion rules) live in `src/app/globals.css`; reusable buttons, notices and fields in
`src/components/ui.tsx`.
