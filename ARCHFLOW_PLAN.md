# ARCHFLOW — Product & Technical Plan

> *"Making property plans something people can actually experience."*

## 1. Product vision

ARCHFLOW is a PropTech platform that turns traditional 2D architectural floor plans into interactive 3D property experiences, so developers and buyers can understand a property before it is built.

```
2D FLOOR PLAN → AI / CV → STRUCTURED FLOOR PLAN → 3D GEOMETRY → INTERACTIVE 3D → VR
```

**Initial customer:** real-estate developers and property sales companies.

## 2. MVP scope

In scope:
1. Upload a PNG/JPG floor plan (validated).
2. Display the uploaded plan.
3. Interpret a basic structure (semi-automatic first; automatic CV as an experiment).
4. Represent walls and rooms as structured data.
5. Convert structured data to simple 3D geometry.
6. Interactive 3D viewer: rotate, zoom, pan, reset, fullscreen, layer toggles, room labels.
7. Interpretation is replaceable by a stronger AI/CV model later.

Out of scope for the MVP: perfect automatic recognition, photorealistic assets, accounts/auth, a database, VR, training custom models.

**Principle:** a reliable prototype beats a pretend-AI. Where detection is unreliable, the user corrects it in a semi-automatic editor. Accuracy is never faked.

## 3. Technical architecture

Seven decoupled systems. The **FloorPlan schema is the only contract** between CV and 3D.

| # | System | Lives in | Depends on |
|---|--------|----------|-----------|
| 1 | Upload | `backend/app/api`, `backend/app/storage` | — |
| 2 | Image processing | `backend/app/processing` | Pillow, OpenCV |
| 3 | Interpretation | `backend/app/interpretation` (pluggable `Interpreter` interface) | processing |
| 4 | Structured floor plan | `backend/app/schema` + mirrored TS types `frontend/src/lib/floorplan` | — |
| 5 | 2D→3D geometry | `frontend/src/lib/geometry3d` (pure TS, no React, no Three.js) | schema types only |
| 6 | 3D rendering + viewer | `frontend/src/components/viewer` (R3F), `frontend/src/lib/viewer` (pure viewer logic) | geometry engine output |
| 7 | UI | `frontend/src/app`, `frontend/src/components` | api client |

Rules: the renderer never sees images; the CV code never sees Three.js; the UI talks to the backend only through `frontend/src/lib/api.ts`.

### Data flow

```
Browser ──upload──▶ FastAPI ──▶ local storage (files)
                       │
                       ▼
              processing (normalize)
                       ▼
     Interpreter (manual | opencv via POST /interpret | future AI)
                       ▼
     FloorPlan proposal + report  ──▶  user reviews/corrects in 2D editor ──▶ saved FloorPlan JSON
                       ▼
        geometry builder (walls, floors, openings)
                       ▼
                R3F viewer ──▶ (later) WebXR
```

### FloorPlan schema (v1, implemented in Milestone 3)

Source of truth: `backend/app/schema/floorplan.py` (pydantic, validated on every save). Mirrored by hand in `frontend/src/lib/floorplan/types.ts`; keep the two in sync.

```json
{
  "version": 1,
  "units": "meters",
  "provenance": "manual",
  "source": { "floorplan_id": "…", "width_px": 1200, "height_px": 800 },
  "scale":  { "meters_per_pixel": 0.01, "calibrated": true },
  "walls":   [{ "id": "wall-1", "start": [1,1], "end": [11,1], "height": 2.8, "thickness": 0.15 }],
  "rooms":   [{ "id": "room-1", "name": "Living Room", "polygon": [[1,1],[11,1],[11,4.5],[1,4.5]] }],
  "doors":   [{ "id": "door-1", "wall_id": "wall-1", "offset": 5.5, "width": 0.9, "height": 2.1 }],
  "windows": [{ "id": "window-1", "wall_id": "wall-3", "offset": 5.4, "width": 1.2, "height": 1.2, "sill": 0.9 }]
}
```

Conventions: metres on the ground plane; **x right, y down** (same as the image, so a traced plan lines up with the picture; the 3D layer maps (x, y) → (x, z)). An opening's `offset` is the distance from its wall's `start` to its near edge. `provenance` (`manual` | `opencv` | `ai`) tells the UI whether a human should review the plan. `scale.calibrated` is false until the user sets a real-world reference distance; nothing pretends an assumed scale is a measurement.

Validation invariants (enforced server-side and mirrored in the editor): unique ids; walls ≥ 5 cm; rooms ≥ 3 corners, non-self-intersecting, ≥ 0.5 m²; openings reference an existing wall, fit within it, are not taller than it, and do not overlap each other.

### 3D geometry engine (implemented in Milestone 4)

`buildScene(plan: FloorPlanData): Scene3D` in `frontend/src/lib/geometry3d/`. It is the only thing between the FloorPlan and the renderer.

```
FloorPlan JSON -> buildScene() -> Scene3D (plain typed arrays) -> R3F renderer -> interactive property
```

* **Independent.** It imports only the FloorPlan *types*. Nothing from the editor, React or Three.js, so it runs and is tested in plain Node. The renderer converts `MeshData` to `BufferGeometry` and owns all colours (the engine only names material slots: wall, floor, door, windowFrame, glass).
* **Deterministic.** Same plan gives bit-identical geometry: fixed object order (walls, floors, doors, windows), no randomness, no mutation of the input, and no `Math.hypot`/trig (not guaranteed identical across JS engines). `sceneFingerprint()` hashes the geometry, so tests and the UI can prove "same plan, same model".
* **True scale.** FloorPlan geometry is already in metres; the engine uses it 1:1 (world X = plan x, world Z = plan y, Y up). `scene.scale.calibrated` is passed through so the viewer can say when sizes are only assumed.
* **Never throws on a slightly wrong plan.** Unusable input (zero-length wall, opening off its wall, overlapping openings, degenerate room) is skipped or trimmed and listed in `scene.warnings`.
* **Correctness by construction.** Faces are wound to match explicit outward normals; tests verify closed-solid volumes against hand-computed values (wall length x height x thickness minus door/window holes, floor area x thickness, room volume).

What it generates:

| Element | Geometry |
|---|---|
| Wall | Boxes along the centreline: full-height blocks between openings, sill below windows, lintel above doors/windows. Ends are extended at corners by half the neighbouring wall's thickness so outer corners are solid. |
| Door | Three-sided frame plus a closed leaf, sitting exactly in the hole. |
| Window | Frame with projecting sill board, plus a separate transparent glass pane. |
| Floor | Slab (10 cm) under each room, triangulated by ear clipping (concave rooms OK), top surface at y = 0. |
| Space | One per room: name, area, ceiling height (tallest wall on its boundary), label anchor, and a closed floor-to-ceiling volume mesh (not rendered by default; for future highlighting/picking). |

Known limits: corner fill is exact for right angles and approximate for other angles; T-junctions rely on the abutting wall body; rooms with holes are not supported; door leaves are drawn closed; no ceilings, furniture, textures or exterior yet. Extension points: new element generators (ceilings, furniture) are new modules that append `SceneObject`s; materials/textures are renderer-only.

### Interactive viewer (implemented in Milestone 5)

```
API JSON (untrusted) -> prepareModel() -> buildScene() -> PropertyViewer
                         lib/viewer        lib/geometry3d    components/viewer
```

* **One gate for untrusted data.** `lib/viewer/prepareModel.ts` turns whatever the API returns into a well-formed `FloorPlanData` (dropping and listing malformed elements, rejecting non-plans and unknown versions), runs the engine, and returns a discriminated result: `invalid | empty | no-geometry | ready`. It never throws, so the UI always has a state to show. The engine itself is unchanged and still assumes well-formed input.
* **Pure logic is React-free and unit tested:** `prepareModel`, `labelAnchor` (label placement inside concave rooms), `layers` (what can be shown), `components/viewer/framing.ts` (aspect-aware framing, preset views, room focus, zoom clamping).
* **Components:** `PropertyViewer` (shell: owns layer/selection/panel state, keyboard shortcuts, fullscreen) → `Viewer3D` (canvas, lights, grid; memoised) → `PropertyScene` (meshes grouped per layer), `RoomLabels` (DOM labels), `CameraRig` (OrbitControls + imperative `CameraApi`: reset, view, focusRoom, zoom). `PropertyPanel` is the side panel; `ViewerErrorBoundary` contains WebGL/render failures.
* **State flow:** layer/selection state lives in the shell and reaches the canvas as plain props; layers map to `visible` on groups (no geometry rebuild). Camera commands go through a ref, never through React state, so moving the camera never re-renders React.
* **Performance:** render on demand (`frameloop="demand"`; frames only while something changes), memoised components, geometries/materials disposed on unmount.
* **Backend:** a stored plan that fails validation on read is reported as `422 invalid_structure`, not a 500.

VR note: labels are DOM overlays and the toolbar is HTML; a WebXR session (M8) will need in-scene equivalents. The camera logic in `framing.ts` and the layer model carry over unchanged. (Done in M8: see section 8.)

### Automatic floor-plan understanding (implemented in Milestone 6)

Scope is deliberately narrow: **one supported drawing style**, defined in `docs/SUPPORTED_FLOOR_PLANS.md` (solid thick axis-aligned walls, arc doors, line windows, dark on light). Everything else is rejected with a reason or left for the user. The output is a **proposal** in the unchanged FloorPlan schema. The editor is where it becomes correct.

```
image ─▶ preprocess ─▶ walls ─▶ rooms ─▶ openings ─▶ scale ─▶ assemble ─▶ FloorPlan + report
         (binarize,     (thickness   (enclosed    (door arcs,   (median     (metres, schema
          deskew,        histogram,   free space,  window lines, door width, rules, omit
          reject)        morphology,  snapped to   unknown gaps) plausibility) low confidence)
                         junctions)   centrelines)
```

* **Modules** `backend/app/interpretation/opencv/`: one file per stage, each returning a frozen dataclass from `types.py` (`Preprocessed`, `WallDetection`, `RoomDetection`, `OpeningDetection`, `ScaleEstimate`), so each stage is testable alone. `pipeline.run_stages` is a generator that yields a `StageEvent` when each stage starts/finishes and finally an `Interpretation` (plan + `InterpretationReport`, `app/schema/interpretation.py`).
* **No invented geometry:** elements scoring < 0.5 are omitted and counted; gaps that are neither a door nor a window split the wall instead of becoming doors; every element is checked against the schema rules and the final plan is validated by the real pydantic model (with step-wise degradation if that ever fails). Plans are always `calibrated: false`. An unsupported image, an unreadable file or a bug in a stage returns an **explained empty result**, never a 500 or a partial guess.
* **Report:** per-element heuristic confidence + evidence + `needs_review` (< 0.7), overall confidence, stage timings/summaries, warnings, omitted counts, scale source. Kept **outside** the FloorPlan so the schema and the 3D engine stay unchanged.
* **API:** `POST /interpret` streams NDJSON progress (real stage events) and stores `interpretation.json`. It never touches the user's saved `structure.json`. `GET /interpretation` returns the stored result. `GET /structure` still uses the manual interpreter, so opening the editor never silently runs CV.
* **Frontend:** `lib/interpretation/` (pure, tested): stream parsing (malformed lines ignored), stage progress, `acceptInterpretation` (the plan goes through the viewer's untrusted-JSON parser; the report is parsed field by field; `needs_review` is recomputed, never trusted; a result for another image is refused), review list. Upload page: **Auto-generate** toggle → live step list → result summary. The editor opens the proposal (`?source=auto`) as **unsaved changes**, with an *Automatic detection* panel (flagged elements, amber highlight, omitted counts, scale source, notes) and per-element confidence in the properties panel. "Auto-detect from image" in the editor applies a result as one undoable step. **The editor, schema and 3D engine are otherwise unchanged.**
* **Evaluation** `backend/evaluation/` (`python -m evaluation.run` → `docs/CV_EVALUATION.md`): 30 synthetic plans in the supported style with exact truth (random scale 55–110 px/m, wall thicknesses, 2/3-line windows, doors next to corners, furniture, text, dimensions, noise, blur, JPEG), 7 synthetic out-of-scope cases, the M2 hand drawing, one **real** apartment plan with hand-traced truth, and one real non-plan (3D render). Metrics: length-based wall recall/precision, room IoU ≥ 0.7 matching, opening centre matching, relative scale error. See the "held-out" caveat in the report.

**Measured (pipeline `opencv-1`):**

| Set | Walls R / P | Rooms R / P | Doors R / P | Windows R / P | Scale error |
|---|---|---|---|---|---|
| Synthetic, supported style (30) | 235/235 · 100% / 100% | 143/145 · 98.6% / 100% | 144/145 · 99.3% / 100% | 212/214 · 99.1% / 100% | median 4.0%, worst 7.7% |
| Real apartment plan (1) | 8/10 · 80% / 93% | 3/4 · 75% / 100% | 1/4 · 25% / 100% | 4/6 · 67% / 100% | 14.1% (from 1 door) |
| Real 3D render (1) | correctly rejected | | | | |
| M2 hand drawing (1) | 7/7 | 4/4 | – | – | n/a (no doors) |

The synthetic numbers show the pipeline does what it is designed to do on its own style. They are **not** real-world accuracy: that is measured on one plan, and is much lower.

**Failure cases (analysed):**
1. *Wide openings in thin-wall drawings* (real plan): a 1.9 m bifold balcony door is ~17 wall thicknesses wide, over the 16× gap limit. The wall is not bridged, the living room connects to the balcony and the outside, and the **largest room is lost**. The user redraws it (6 clicks in the browser test).
2. *Door symbols other than a 90° arc* (real plan): a partly-open entrance door and a bifold door → unidentified openings (walls split, no door invented). Doors drawn as plain gaps (synthetic) → 0/5 doors, and the scale falls back to the assumption (40% off).
3. *Doors next to wall junctions*: the stub beside the door is too small to detect, so the gap is wider than the door. Fixed in M6 with a narrower-arc search (synthetic 139 → 144 of 145 doors, real 0 → 1 of 4). The real bedroom door is still missed.
4. *Scale from few doors*: the real plan's scale comes from its one detected door and is 14% off (the assumed fallback would have been 4% off, by luck). Always calibrate.
5. *Confidence does not see omissions*: on the real plan every detected element scored ≥ 0.75, so nothing is flagged, while a room and 3 doors are missing. Omissions are only visible through warnings.
6. *Out of scope (synthetic)*: low resolution (28 px/m: 4/7 walls, 0/4 rooms); heavy degradation (3/7 windows); a diagonal wall (not detected, one extra room); a thick title-block frame (5 extra walls, 1/6 rooms); hollow walls (rejected). A 3° rotation is handled (deskew).
7. *No OCR*: room names and written dimensions are ignored.

### Real-estate MVP (implemented in Milestone 7)

A thin **project layer** around the unchanged M3–M6 systems. The floor plan is still uploaded, detected, edited and
saved through `/api/floorplans/...`; the FloorPlan schema, CV pipeline, geometry engine and 3D renderer did not change.

```
Project (name, address, description) ──1:1──▶ floor plan (image, interpretation.json, structure.json)
      │
      └── publish ──▶ share snapshot  shares/<token>.json  ──▶  GET /api/share/{token}  ──▶  /share/<token> (buyer)
```

* **Storage** (`app/storage/projects.py`): files, no database. `projects/<id>/project.json` holds the record and the
  share token; the floor plan's `meta.json` gained an optional `project_id` (old records still load). Writes are atomic,
  ids are uuid4 hex and share tokens are 144-bit `secrets.token_urlsafe` values; both are validated before touching the disk.
* **API** (`app/api/projects.py`): CRUD, attach floor plan, publish/unpublish, and a per-project **summary** computed from
  the saved plan (saved?, damaged?, calibrated?, element counts, floor area, auto-detected?) plus the share status. The
  dashboard therefore never needs to parse plans itself.
* **Sharing = snapshot, not live link.** Publishing copies the saved plan and the public details into `shares/<token>.json`,
  so a half-finished edit never reaches buyers. `up_to_date` compares the snapshot with the current plan and details;
  the developer republishes to the same link. Revoking deletes the file.
* **Least exposure.** The public document contains only name, address, description and the plan, with
  `source.floorplan_id` replaced by `"shared"`: a buyer link reveals no id that could reach an editable resource. The
  buyer route is read-only (GET only), the page links nowhere into the app and is `noindex`.
* **Frontend:** `/projects` (dashboard), `/projects/new` (create), `/projects/{id}` (hub: upload step reusing the M6
  components, plan card, progress checklist, share panel, delete), `/share/{token}` (buyer page). Pure logic is in
  `lib/projects/status.ts` (stage, checklist, next action, form rules mirroring the backend, share URL, relative times)
  and `lib/viewer/tour.ts` (presentation tour state machine). Both are unit tested.
* **Viewer additions** (props on `PropertyViewer`, no change to the canvas, camera or engine): `audience="public"` hides
  links into the editor and the model internals; **presentation mode** reuses the existing fullscreen hook and camera
  moves (`reset`, `focusRoom`) for an overview-then-rooms tour with a title card.
* **No accounts** (MVP decision, see §2). Anyone who can reach the API can manage projects; buyer links are unguessable
  but not access-controlled beyond that. Adding auth later means guarding `/api/projects*` and `/api/floorplans*`;
  `/api/share/*` stays public.

## 4. Folder structure

```
archflow/
  frontend/         Next.js + TS + Tailwind + R3F
  backend/          FastAPI + OpenCV + Pillow
    app/api/  app/config.py  app/main.py
    tests/
  docs/
  README.md  ARCHFLOW_PLAN.md  PROGRESS.md  .env.example  .gitignore
```

Storage is local files under `backend/storage/` (`floorplans/`, `projects/`, `shares/`). No database until multi-user access requires it (sharing in M7 works with files).

## 5. Development phases

| Milestone | Goal |
|---|---|
| 1 | Foundation: structure, both apps run, health check, README |
| 2 | Upload: validated PNG/JPG, preview, processing state, frontend↔backend |
| 3 | FloorPlan model + semi-automatic wall/room editor over the uploaded image |
| 4 | 2D→3D geometry: walls, floors, door/window placeholders |
| 5 | Interactive viewer: orbit/zoom, lighting, layer toggles, labels, reset, fullscreen |
| 6 | CV experiment: walls, rooms, doors, windows, dimensions via OpenCV |
| 7 | Real-estate MVP: property projects, dashboard, persistent saved properties, shareable read-only buyer page, presentation mode, demo polish |
| 8 | VR / WebXR: optional immersive walkthrough of the same 3D model (enter/exit, walking with wall collision, snap turn, teleport, room-to-room, in-scene room labels and HUD) |

## 6. Known technical risks

- **Floor-plan diversity.** Drawing styles, scales, text, furniture and hatching make classical CV brittle. Mitigation: semi-automatic editing; CV outputs are suggestions.
- **Scale.** Pixels → metres needs a reference (known dimension or user calibration). Mitigation: user sets scale in the editor.
- **Room detection.** Rooms need closed wall loops; gaps at doors break naive flood fill. Mitigation: close door gaps, validate polygons.
- **Geometry robustness.** Wall junctions, non-rectilinear rooms, holes for openings. Mitigation: tested pure-function geometry layer.
- **Performance** on low-end devices and later in VR. Mitigation: simple materials, instancing, no heavy assets.
- **Upload safety.** Malicious or huge files. Mitigation: type sniffing via Pillow, size/dimension limits, generated filenames.
- **Tooling:** git is not installed on the dev machine yet.

## 7. Future AI/CV architecture

An `Interpreter` interface (`image → FloorPlan`) with interchangeable implementations: `ManualInterpreter` (empty plan for the editor), `OpenCVInterpreter` (Milestone 6, implemented), and later `ModelInterpreter` (hosted segmentation/VLM). The output is always validated against the schema, and carries per-element confidence (the M6 `InterpretationReport`) so the UI can highlight uncertain items for human review. A new interpreter can reuse the M6 stream protocol, report, review UI and evaluation harness unchanged. Human corrections (proposal in `interpretation.json` vs. saved `structure.json`) are already stored side by side and can become training/evaluation data.

## 8. VR architecture (implemented in Milestone 8)

```
FloorPlan -> buildScene() -> Scene3D -> Viewer3D canvas (desktop: OrbitControls)
                                            └─ VRSession (WebXR: same canvas, scene, materials)
```

* **No second engine, no new dependency.** VR is the existing R3F canvas presented through the standard WebXR API (`navigator.xr.requestSession("immersive-vr")` + three.js `WebXRManager`, which R3F already drives: during a session it renders every XR frame even with `frameloop="demand"`). `@react-three/xr` (the earlier plan) was not needed. Nothing VR-related runs or renders until a session starts.
* **Availability** (`lib/vr/support.ts`, `hooks/useVRSupport.ts`): decided only by `isSessionSupported("immersive-vr")` on a secure page, re-checked on `devicechange`. States: supported, unsupported (no headset), no-webxr, insecure (http), error (blocked). The toolbar shows **Enter VR** only when supported; otherwise **VR unavailable** opens a plain-language explanation. The UI state machine (`vrReducer`) follows the session's real `sessionstart`/`sessionend` events.
* **Rig** (`components/viewer/vr/VRSession.tsx`): on session start the desktop camera (pose, fov, near/far) is saved and the camera is parented to a play-space group; on end it is restored exactly and OrbitControls re-synced (`CameraRig enabled={false}` during VR). Reference space `local-floor` (fallback `local` + 1.6 m eye height), so the floor is at y = 0 and there is no gravity to fall through. The shadow map is drawn once per session (static model).
* **Navigation maths is pure and unit tested** (`lib/vr/collision.ts`, `lib/vr/navigation.ts`):
  * *Collision* comes from the engine's own output: wall and window meshes are sliced at 0.35 m and 1.1 m into 2D segments. Door holes are already cut in the walls, so doorways are open. The visitor is a 0.2 m circle around the head; moves are sub-stepped, pushed out of walls (sliding along them) and refused if the straight step would still cross a segment.
  * *Start* in the largest room at its roomiest interior point (`labelAnchor`), facing the deepest view that stays inside the property (sight lines out through exterior doors are not counted).
  * *Room stops*: one standing point per room, in plan order. `placeRig()` computes the rig pose that puts the tracked head exactly on a target with a target heading (start, room jumps, teleports, snap turns around the head).
* **Controls:** left stick walk (head-relative, 1.4 m/s, dead zone), right stick snap turn 30°, trigger hold-aim-release teleport (onto a room floor, in line of sight, not against a wall), A/X next room and B/Y previous room with a short fade, both grips held 1 s to leave (plus the headset's own exit and an **Exit VR** button on the page). Movement uses a capped frame step; hold/fade timers use real time.
* **In-scene text** (DOM overlays do not exist in a headset): room labels are canvas-texture billboards above head height (`VRRoomLabels`); a head-locked HUD shows the current room and area (≈ when uncalibrated) and is emphasised for 4 s on entering a room; a welcome card explains the controls until the first button press. No font files or network.
* **VR-only look:** daylight sky, soft fill light, a ground disc around the house, doors drawn see-through (the engine's door leaves are closed; in VR they read as passable), 1 m grid and HTML labels hidden. The desktop look is unchanged.
* **Testability:** the canvas exposes `data-vr`, `data-vr-head`, `data-vr-room`, `data-vr-aim`, `data-vr-welcome` (like `data-camera`), so a browser test with an emulated WebXR runtime can verify movement, rooms and exits.

## 9. Future roadmap (recorded 2026-10-13; not approved, not started)

Ideas recorded for planning only. Neither feature may be implemented until the user separately approves its scope. Both rule out paid APIs, paid or external assets, CDNs and new paid dependencies.

### Future Feature A: First-person walkthrough (desktop/mobile, not VR)

* Buyers explore the generated property at eye level, moving through connected rooms with smooth movement and camera turning.
* Movement respects room connectivity and must not pass through walls.
* Controls: keyboard and mouse on desktop; touch controls to be considered for mobile.
* **Guided-tour mode:** moves through the rooms automatically with cinematic camera transitions; pause, resume, skip and exit controls.
* Later, investigate exporting the guided tour as a video. This is **not** supported today and must not be assumed.
* Separate from the WebXR VR mode (§8). Where it is safe, reuse the existing geometry and the pure navigation code (`lib/vr/collision.ts`, `lib/vr/navigation.ts`: wall segments from the generated meshes, room stops, `labelAnchor` start points). Do not claim the navigation is accurate until that has been verified.

### Future Feature B: Procedural outdoor environment

> **Status 2026-10-14:** a first version was requested by the user and implemented as the "Procedural outdoor environment" polish item (see PROGRESS.md): Off / Minimal / Suburban / Urban, desktop only, hidden in VR. It is **awaiting the user's review**. Anything beyond that scope stays unapproved.

* An optional presentation setting around the property: roads, sidewalks, grass, bushes, trees and simple landscaping.
* Configurable styles, e.g. suburban, urban, landscaped. The environment can be switched off.
* Built from locally generated geometry and procedural materials where practical (same approach as the polish #1 procedural floor textures). No external asset files.
* Performance budget matters, especially on phones and low-powered devices.
* **Always illustrative:** the UI must never imply that generated surroundings show the property's real location or a surveyed site, unless real site data is supplied.
