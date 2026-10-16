# ARCHFLOW

> Making property plans something people can actually experience.

ARCHFLOW turns a 2D architectural floor plan into an interactive 3D model of the property that a developer can
check, correct and present, and that buyers can explore in the browser through a read-only link.

It is an MVP that runs on one machine: a Next.js frontend and a FastAPI backend that stores everything as local files.
See [ARCHFLOW_PLAN.md](ARCHFLOW_PLAN.md) for the architecture and [PROGRESS.md](PROGRESS.md) for the detailed history,
test results and known limits of every milestone.

## What it does

1. **Create a property** with a name, an optional address and a description for buyers.
2. **Upload its floor plan** (PNG or JPG). With *Detect the walls and rooms for me* ticked, an OpenCV pipeline proposes
   walls, rooms, doors, windows and a scale estimate, with live progress and a confidence report.
3. **Review and correct** the result in the 2D editor: delete or redraw elements, rename rooms, set the real scale from a
   known dimension, then save. Nothing is saved until you do. Plans can also be traced entirely by hand.
4. **Explore it in 3D**: orbit, zoom, top view, fly to any room, room labels, layer switches, fullscreen, and optional
   illustrative surroundings (Off · Minimal · Suburban · Urban).
5. **Present it** as a guided tour (overview, then each room with its area).
6. **Share it with buyers**: publish a read-only buyer page with an unguessable link. Buyers need no account.
7. **View it in VR** (WebXR) on a browser and headset that support immersive VR: walk with wall collision, snap turn,
   teleport and jump from room to room.

### What it does not do (yet)

* **Automatic detection supports one drawing style**: clean plans with solid, thick, axis-aligned walls, arc doors and
  line windows ([docs/SUPPORTED_FLOOR_PLANS.md](docs/SUPPORTED_FLOOR_PLANS.md)). Other drawings (hatched or hollow walls,
  diagonal or curved walls, photos, 3D renders) are rejected with a reason or detected incompletely, and you trace or
  fix them in the editor. Measured accuracy, including where it fails, is in
  [docs/CV_EVALUATION.md](docs/CV_EVALUATION.md) and [docs/REAL_WORLD_VALIDATION.md](docs/REAL_WORLD_VALIDATION.md).
  The scale is only an estimate until you calibrate it. Room names and written dimensions are not read (no OCR).
* **VR has been verified only with an emulated headset** (Meta's IWER WebXR emulator in automated browser tests).
  It has **not** been tested on a physical headset.
* **No per-user accounts.** Developers share one sign-in password (see [Sign-in](#sign-in)); it is off for local use.
  Buyer links stay public and unguessable. Public deployment is not set up yet (see PROGRESS.md).
* One storey per property. Surroundings are always invented for presentation and labelled as illustrative; they never
  show the property's real site.

## Requirements

| | Required | Tested with |
|---|---|---|
| Node.js | 20.9 or newer (required by Next.js 16) | 24.21.0 with npm 11.19.0 |
| Python | 3.13 (dependencies are pinned for it) | 3.13.14 |
| Browser | a current Chromium-based browser with WebGL | Microsoft Edge on Windows 11 |

Development and testing were done on **Windows 11**. The macOS/Linux commands below are the standard equivalents but
have not been tested. The first `npm run build` downloads the Geist and Newsreader fonts once (they are then served by
the app itself); no other network services, API keys or paid accounts are used.

## Setup (first time)

**Backend** (Windows PowerShell)
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
```

**Frontend**
```powershell
cd frontend
npm ci
copy .env.local.example .env.local
```

On macOS/Linux: `python3 -m venv .venv`, `.venv/bin/pip install -r requirements.txt`, and
`cp .env.local.example .env.local`.

`frontend/.env.local` holds only `NEXT_PUBLIC_API_URL` (the backend's address, `http://localhost:8000` by default).
Backend settings (`ARCHFLOW_CORS_ORIGINS`, `ARCHFLOW_MAX_UPLOAD_MB`, `ARCHFLOW_STORAGE_DIR`) are optional; see
[.env.example](.env.example).

## Run

Use two terminal windows and keep both open. Start the backend first.

**Backend** (http://localhost:8000, API docs at `/docs`)
```powershell
cd backend
.\.venv\Scripts\python -m uvicorn app.main:app --port 8000
```
(macOS/Linux: `.venv/bin/python -m uvicorn app.main:app --port 8000`. Add `--reload` while developing.)

**Frontend, production build** (what the demos and browser tests use)
```powershell
cd frontend
npm run build      # once, and again after any frontend change
npm start          # serves the build on http://localhost:3000
```

**Frontend, development** (hot reload, slower, shows dev-only warnings)
```powershell
cd frontend
npm run dev
```

Open http://localhost:3000. The header shows *Engine online* when the frontend can reach the backend.

To stop, press **Ctrl+C** in each window (frontend first). Saved properties stay on disk in `backend/storage/`.
`NEXT_PUBLIC_API_URL` is built into the frontend at `npm run build`, so rebuild after changing it.

### Sign-in

Locally, sign-in is **off** by default and everything works without a password. In this development mode (the
default) the backend **answers only this computer**; requests from other machines get 403, so a server started without
its production settings exposes nothing. A Quest connected with `adb reverse` counts as this computer. Sign-in is
**required** when the backend runs with `ARCHFLOW_ENV=production`, which refuses to start without it (and refuses
`ARCHFLOW_RATE_LIMITS=false` or `ARCHFLOW_COOKIE_SECURE=false`).

1. Create the password hash on your own machine (the password is asked twice, never shown, stored or sent):
   ```powershell
   cd backend
   .\.venv\Scripts\python -m app.security.passwd
   ```
2. Give the backend two environment variables (never commit them): `ARCHFLOW_ADMIN_PASSWORD_HASH` (the printed
   hash) and `ARCHFLOW_SESSION_SECRET` (32+ random characters, e.g. from
   `python -c "import secrets; print(secrets.token_urlsafe(48))"`). Restart the backend.
3. Developers sign in at `/login` with the password; tell it to them in person or through a password manager.
   **Sign out** is in the header. Sessions last 12 hours and are renewed while in use.

To sign everyone out (e.g. after someone leaves), set a new password hash or session secret and restart.

What is protected: every `/api` route except `/api/health`, the sign-in routes and the buyer link
`/api/share/{token}`. Buyer pages (`/share/...`) never ask for a password. With sign-in on, every change must carry the
header `X-ARCHFLOW-CSRF: 1` (the frontend adds it), uploads and automatic detection are rate limited per client
(on by default in production), sign-in attempts are limited per client and overall, and at most 2 uploads, 1 detection
and 2 password checks are processed at the same time (others get "busy, try again"). Limits are kept in memory, so run
the backend as a single process. All settings are listed in [.env.example](.env.example).

The client address used for limits is the one uvicorn reports. By default uvicorn takes it from `X-Forwarded-For` for
connections from this machine (`127.0.0.1`/`::1`), so a reverse proxy on the same machine must overwrite that header
with the real client address (Caddy does by default) and be the only way in; without a proxy in front, start uvicorn
with `--forwarded-allow-ips=""`.

## Using it

1. **Properties** (`/projects`): every property as a card with its plan, status, rooms, area and last update.
   **New property** creates one.
2. **The property page** (`/projects/{id}`) is the hub: upload step, the plan with its figures, a progress checklist
   (upload → review & save → set scale → share), the next step as one button, **Edit details**, **Replace floor plan**,
   the buyer link and **Delete property** (confirmed in a dialog). No plan at hand? **Use the sample apartment** loads a
   7-room plan in the supported style with an 11.75 m dimension to calibrate from.
3. **After detection**, *Here's what we found* shows the counts, a confidence badge and warnings.
   **Review & correct in editor** opens the result as an **unsaved proposal**.
4. **The editor** (`/plans/{id}/edit`): the *Detected automatically* panel lists flagged elements (outlined on the plan),
   elements left out as too uncertain, the scale source and detector notes. **Auto-detect from image** runs detection
   on any uploaded plan as one undoable step. Shortcuts: `V` select · `W` wall · `R` room · `D` door · `N` window ·
   `C` set scale · `Del` delete · `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo · `Ctrl+S` save · `Esc` cancel · `Enter` close a
   room · right-click ends a wall chain.
5. **The 3D view** (`/plans/{id}/view`) is generated from the saved plan by the geometry engine in
   `frontend/src/lib/geometry3d/`.

| Action | Mouse | Touch | Key |
|---|---|---|---|
| Rotate | drag | one finger | |
| Zoom | scroll (toward the cursor), **+ / −** | pinch | `+` `−` |
| Pan | right-drag or Shift+drag | two fingers | |
| Reset to the overview | **Reset** | | `R` |
| Look straight down | **Top** | | `T` |
| Fullscreen | fullscreen button (Esc to leave) | | `F` |
| Room labels on/off | panel switch | | `L` |
| Presentation tour | **Present** | | `P` · `←` `→` · `Space` · `Esc` |
| VR | **View in VR** explains what is needed; **Enter VR** appears only when a headset is available | | |

   The side panel shows floor area, rooms, walls, doors, windows, footprint, wall height and whether the scale is
   calibrated; a room list (click to fly to a room); layer switches; and the **Surroundings** choice. Uncalibrated plans
   are marked everywhere with "≈" and an *Approximate sizes* badge.

6. **Buyer page**: **Publish buyer page** creates a link like `http://localhost:3000/share/<token>` (**Copy**,
   **Open buyer page**). Buyers see the name, address, description, key figures and the interactive model, with
   presentation mode (also via `?present=1`); nothing links to editing and search engines are asked not to index it.
   A published page is a **snapshot**: later edits reach buyers only after **Update buyer page** (the link stays the
   same). **Switch off link** disables it immediately.

### VR (WebXR)

VR uses the same model and canvas through the standard WebXR API; no extra service or dependency.

* **Requirements:** a browser with WebXR immersive-VR support and a headset (for example the Meta Quest Browser, or
  Chrome/Edge with a PC-VR headset), on an HTTPS page or `localhost`. Otherwise **View in VR** explains what is missing
  and the 3D view works as usual.
* **From a Quest over USB:** enable developer mode, connect it, run `adb reverse tcp:3000 tcp:3000` and
  `adb reverse tcp:8000 tcp:8000`, then open `http://localhost:3000` in the Quest Browser. Serving over a network instead
  needs HTTPS for both servers, `NEXT_PUBLIC_API_URL` pointing to the backend's address (rebuild afterwards) and
  `ARCHFLOW_CORS_ORIGINS` including the page's origin. *(Documented, not exercised: no physical headset was available.)*
* **Controls:** left stick walk (walls stop you, doorways are open) · right stick 30° turn · trigger aim-and-release to
  teleport · A/B (X/Y) next/previous room · hold both grips 1 s, the headset's exit, or **Exit VR** on the page to leave.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Liveness (public) |
| GET | `/api/auth/me` | Whether sign-in is on and this browser is signed in (public) |
| POST | `/api/auth/login` / `/api/auth/logout` | Sign in with `{password}` (sets the session cookie) / sign out (public, rate limited) |
| POST | `/api/floorplans` | Upload PNG/JPG (`multipart/form-data`, field `file`) |
| GET | `/api/floorplans/{id}` | Floor plan metadata |
| GET | `/api/floorplans/{id}/image` | Normalized PNG |
| GET / PUT | `/api/floorplans/{id}/structure` | Saved structured plan (or a fresh empty one) / validate and save it |
| POST | `/api/floorplans/{id}/interpret` | Run automatic detection; streams progress as NDJSON, stores the result as a proposal (never overwrites the saved plan) |
| GET | `/api/floorplans/{id}/interpretation` | The last automatic result with per-element confidence; 404 if never run |
| GET / POST | `/api/projects` | List properties / create one (`{name, address?, description?}`) |
| GET / PATCH / DELETE | `/api/projects/{id}` | Property with plan summary and share status / change details / delete it with its plan and link |
| PUT | `/api/projects/{id}/floorplan` | Attach an uploaded floor plan (`{floorplan_id}`) |
| POST / DELETE | `/api/projects/{id}/share` | Publish or update the buyer page / switch the link off |
| GET | `/api/share/{token}` | **Public, read-only**: the published property and plan (no internal ids) |

Errors use `{"error": {"code": "...", "message": "..."}}`; with sign-in on also 401 `unauthorized`, 403 `csrf_failed`,
429 `rate_limited` and 503 `busy` (both with `Retry-After`). Every route not marked public needs a session when
sign-in is on. Data is stored as files under `backend/storage/` (`floorplans/`, `projects/`, `shares/`), which is
git-ignored.

## Tests

```powershell
cd backend
.\.venv\Scripts\python -m pytest

cd ..\frontend
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Detection accuracy report: `cd backend; .\.venv\Scripts\python -m evaluation.run` (images of unknown licence in
`backend/evaluation/real/` are not versioned; missing cases are skipped). The end-to-end browser tests used during
development are not part of the repository; their results are recorded in PROGRESS.md.

## Project structure

```
backend/    FastAPI app (app/), OpenCV interpretation pipeline, file storage, tests, accuracy evaluation
frontend/   Next.js app: pages (src/app), editor, 3D viewer and VR (src/components), pure logic (src/lib)
docs/       supported floor plans, accuracy evaluation, real-world validation
```

## License

Copyright (c) 2026 the ARCHFLOW authors. **All rights reserved.** The code is published for viewing and evaluation
only; no permission to use, copy, modify or distribute it is granted. See [LICENSE](LICENSE).
