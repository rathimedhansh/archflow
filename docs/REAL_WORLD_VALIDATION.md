# Real-world validation of the M6 pipeline (2026-09-27)

Five real architectural floor plans, chosen to be as different from each other as possible, were each taken
through the full product flow in a real browser (Edge + SwiftShader WebGL, production build, real backend):

**Upload → Auto-detect → Review → Fix/accept → Calibrate → Save → View in 3D**

The images are openly licensed Wikimedia Commons files. Sources and licences are listed in
`backend/evaluation/real/README.md` (the images are kept local, not versioned). Detection results were judged by
hand against each drawing. These five plans are **not** cases in `evaluation/cases.py`, so the counts below are
careful manual tallies, not output of the metrics code. Where a plan has a written dimension, it was used as the
scale truth.

Pipeline: `opencv-1` with the four bug fixes described at the end of this document. The numbers below are
*after* the fixes, and the "Before the fixes" lines show what changed.

## Summary

| Plan | Style | Auto-detect | Walls | Rooms | Doors | Windows | Detected scale | 3D |
|---|---|---|---|---|---|---|---|---|
| India 2BHK | Colour-rendered CAD, thick solid black walls, tiled floors, furniture, feet-inch labels (1920×2290) | ✅ supported | all thick walls found; 3 false 0.25 m stubs | 7/8 found, 1 false | 5/7 found, 1 false | 7/7 found, 2 false | −14.6 % | ✅ loads |
| Berlin P2 flat | Grey filled walls, no door arcs, dashed blue windows, tightly cropped, low-res (651×510) | ✅ supported | all solid walls found; 1 false stub; 2 small piers dropped | 3/8 found, 1 merged | 0/≈7 (plain gaps); 1 false | 0/≈8 (unsupported symbol); 1 false | ≈ +176 % (from one false door) | ✅ loads |
| Spain CAD | Black solid walls, **diagonal bay**, terrace, stair, furniture, areas written (818×498) | ✅ supported | all straight walls found; 2 diagonal walls missed; 4 false (symbols) | 3/7 found | 4/6 found | 8/10 found, 1 false | −19.6 % | ✅ loads |
| US CAD sample | **Hatched** walls, diagonal bay, furniture, sill-height labels (842×569) | ⛔ rejected (correct, explained) | — | — | — | — | — | ✅ loads (traced by hand) |
| HABS survey | Measured drawing, **hollow double-line** walls, hatched floors, title block, notes (1920×1484) | ⛔ rejected (correct, explained) | — | — | — | — | — | ✅ loads (traced by hand) |

* **Final 3D model loaded and rendered for all 5 plans** (32–37 % of the canvas covered by geometry, correct counts,
  "Calibrated", no scene adjustments, no viewer error, no console errors). Browser check result: **48/48 checks passed**.
* **Invalid geometry:** every automatic proposal opened in the editor with **0 validation issues**, and every corrected plan
  saved through the server's normal validation. One real case of physically invalid output was found and fixed: before the
  fixes, a window on the India plan spanned two T-junctions, so partition walls ended inside a window hole (bug 2 below).
* **Scale:** the door-based estimate was 15–20 % off on the two plans with a written dimension. On the Berlin plan it was
  wrong by a factor of ≈ 2.8, because it rested on a single door that was itself a false detection. It passed the
  plausibility check anyway. After calibrating from a known dimension, the HABS model's footprint came out at
  **9.81 × 12.29 m** against the drawing's written **32'-2¼" × 40'-3" (9.81 × 12.27 m)**.
* **Review flags do not find the false detections.** Of the 15 false detections on the three supported plans, only 6 were
  flagged "needs review". The rest scored 0.7–1.0. Several correct elements *were* flagged. The flags help, but they are
  not a list of what is wrong. This matches the existing caveat in `SUPPORTED_FLOOR_PLANS.md`.

## Per plan

### 1. India 2BHK ground floor (`india-2bhk-colour.png`)

* **Detected:** 18 walls, 8 rooms, 6 doors, 9 windows; overall confidence 0.91; 2 elements flagged.
  Upload + detection took 4–8 s wall clock for this 4.4 MP image (the pipeline itself: ≈ 0.5 s).
* **Rooms:** stair hall, living + dining (one open space), WC, bath, toilet, both bedrooms ✔. **Missed:** kitchen (its left wall
  crosses the living-room wall mid-span and has two free ends, so it is treated as unanchored. Then the utility door
  next to it cannot be bridged and the kitchen "leaks" outside). **False:** a 0.9 m² "room" in the open nook in front of the WC
  door. Entrance lobby (open porch) and utility (railing) are correctly not rooms.
* **Doors:** both bedroom doors, bath, toilet, WC ✔. **Missed:** the D2 double entrance door (read as a window) and the
  utility door. **False:** a door across the open nook in front of the WC (created by bridging a free wall end to the kitchen
  wall).
* **Windows:** all 7 (living, kitchen, 3 bathroom vents, 2 bedrooms) ✔. **False:** the D2 double door, and the open
  kitchen–living passage (a tile-edge line was read as a window line; flagged 0.65).
* **Walls:** all thick walls ✔. **False:** 3 short (0.25 m) stubs at window jambs, inside the wall body and not visible in 3D.
* **Scale:** estimated 110.1 px/m from 6 doors vs 128.9 px/m measured (bedroom 10'0" = 393 px) → **−14.6 %**.
* **Warnings:** "1 short isolated thick mark ignored", "1 wall opening could not be identified".
* **Fixes in the editor:** deleted the false door, false room and 2 false windows; traced the kitchen; added the D2 door
  (1.2 m); calibrated from the bedroom width. Saved: 18 walls, 8 rooms, 6 doors, 7 windows, 85.4 m².
* **Before the fixes:** 1 door and 11 windows. All five swing-arc doors were read as windows (threshold lines), and three
  doors plus two wall junctions were merged into **one window 2.6 m wide**.

### 2. Berlin P2 4-room flat (`berlin-p2-grey.png`)

* **Detected:** 25 walls, 4 rooms, 1 door, 1 window; overall 0.86; 2 flagged; "low resolution" warning (651×510).
* **Walls:** all grey solid walls ✔, including the Zimmer 4 and Zimmer 2 wings. **False:** a 0.5 m bathroom-fixture line (flagged).
  **Dropped:** 2 short facade piers between windows (reported as "2 short isolated thick marks ignored").
* **Rooms:** bathroom, Zimmer 2, Zimmer 3 ✔. Wohnzimmer and Flur came out **merged** into one room (an island warning was
  shown). **Missed:** Zimmer 4, Kammer, Küche (bounded by dashed lines/windows, not walls). 1 low-confidence room omitted (warned).
* **Doors:** the drawing has **no swing arcs**, only plain gaps. All 10 gaps were correctly left as unidentified openings
  (warned). **False:** a double door on the open kitchen pass-through (0.81, not flagged).
* **Windows:** the dashed blue symbol is not supported; none detected, and the gaps stay open in 3D. **False:** the Flur →
  Zimmer 2 doorway read as a single-line window (flagged 0.65).
* **Scale:** estimated 130.5 px/m **from one door, and that door was a false detection**. With the drawing's (assumed) 12 m
  building depth the true value is ≈ 47 px/m, so rooms came out about 2.8× too small (e.g. a 1.5 m wide bedroom). The drawing
  has no dimension, so calibration used an **assumed** 12.0 m P2 building depth.
* **Fixes:** deleted the false door and window; traced Zimmer 4, Kammer, Küche; calibrated. Saved: 25 walls, 7 rooms, 92.9 m².
* **Before the fixes:** only 20 walls and 3 rooms. The Zimmer 4 and Zimmer 2 wings, whose walls lie on the image border,
  **lost all their walls** (bug 1), and every assembly warning was printed twice (bug 4).

### 3. Spanish house with a diagonal bay (`spain-cad-diagonal.png`)

* **Detected:** 18 walls, 3 rooms, 4 doors, 9 windows; overall 0.84; 6 flagged.
* **Walls:** every straight wall ✔. **Missed:** the 2 diagonal bay walls (unsupported). **False:** 4 short walls on the stove,
  fridge and stair symbols and a window tick (3 of them flagged).
* **Rooms:** dormitorio ✔, hall ✔; bathroom ✔ but its outline includes the service shaft next to it. **Missed:** cocina (its
  exterior door has no wall stub on one side, so it leaks outside), vestíbulo, stair, and estar-comedor (bounded by the diagonal walls).
* **Doors:** dormitorio, cocina, bathroom (width underestimated: 0.5 m instead of ≈ 0.7 m), vestíbulo ✔. **Missed:** kitchen
  exterior door, terrace door next to the bay.
* **Windows:** 8/10 ✔ (the 2 on the diagonal walls missed). **False:** one on the service shaft (confidence 1.0).
* **Scale:** estimated 35.3 px/m vs 43.9 px/m (14 m overall width in the drawing's title; the dormitorio's written 10.51 m²
  agrees) → **−19.6 %**. The drawn doors are ≈ 0.7 m wide, not the assumed 0.85 m.
* **Fixes:** deleted 4 false walls and the false window; drew the 2 diagonal walls; traced cocina and estar-comedor
  (with the diagonal bay); calibrated. Saved: 16 walls, 5 rooms, 4 doors, 8 windows, 73.5 m² (the drawing states 68.6 m² net;
  ARCHFLOW measures to wall centrelines).
* **Before the fixes:** identical result (no bug affected this plan).

### 4. US CAD sample with hatched walls (`us-cad-hatched.png`)

* **Rejected:** "No walls drawn as solid, thick lines were found. This happens when walls are drawn as two thin outlines or
  hatched…" This is correct and accurate for this drawing. The result screen offered "Trace walls & rooms by hand".
* **Manual path:** traced the outline including the diagonal bay (12 walls) plus 2 interior walls and 3 rooms. The drawing
  has no dimension, so the scale was calibrated from an **assumed** 0.9 m front door. Saved and viewed in 3D.

### 5. HABS measured drawing (`habs-survey.png`)

* **Rejected** with the same (correct) explanation: walls are hollow double lines, floors are hatched, and the sheet has
  a title block and notes.
* **Manual path:** traced 10 walls and 6 rooms, then calibrated from the written 32'-2¼" dimension. The 3D footprint is
  9.81 × 12.29 m against the drawing's 9.81 × 12.27 m.

## Bugs found and fixed (with regression tests)

All four are in the M6 CV pipeline. **The M4/M5 geometry engine and the viewer were not changed:** no real test exposed a
problem there. Regression tests are in `backend/tests/test_cv_realworld_regressions.py` (6 tests). Each test was
confirmed to **fail with its fix undone** and to pass with it.

1. **Walls lying on the image border were lost** (`walls.py`). OpenCV's erosion treats outside the image as ink by default.
   A wall along the border therefore survived the opening *across* it, fused the two walls at its ends into one U-shaped
   blob, and `_bands` dropped that blob silently. Tightly cropped plans are common. Fix: all wall/thickness openings use
   `open_rect`, which treats outside the image as paper.
2. **An opening could span a wall junction** (`walls.py`). The collinear merge recorded one long gap straight through
   T-junctions, so separate doors either side of a partition became one opening (physically invalid: the partition ended
   inside the hole). Fix: `_split_gaps_at_junctions` cuts every gap at perpendicular walls meeting it.
3. **Swing-arc doors with a threshold line were read as windows** (`openings.py`). The door test required an empty gap, and
   one line across the gap meant "window". Many CAD drawings close door gaps with a threshold line. Fix: a gap with exactly
   one line **and** a door arc above the door threshold is a door. A single line without an arc is still a window (tested).
4. **Every assembly warning was reported twice** (`pipeline.py`). The assembly's warnings were collected by the stage wrapper
   and then appended again.

Checks after the fixes: backend **79/79** (73 + 6 new), frontend 99/99, `python -m evaluation.run` **unchanged** on all
39 synthetic/real cases (supported set: walls 100 %/100 %, rooms 98.6 %/100 %, doors 99.3 %/100 %, windows 99.1 %/100 %).

## Limitations confirmed (not changed, by design or out of scope)

* Hatched and hollow walls: rejected with an explanation (2 of 5 real plans). This is the biggest coverage gap.
* Diagonal walls, dashed window symbols, doors without arcs, sliding/bifold doors: not detected. Plain gaps are left open
  in the wall.
* A wall that crosses another wall mid-span with both ends free is scored as unconnected (low confidence), and nothing can
  be bridged to it. Rooms next to it can leak (India kitchen).
* Bridging a free wall end to a perpendicular wall can invent a door and a small room in open space (India WC nook).
* Line-count window evidence can be fooled by floor-tile edges and hatched shafts (India, Spain).
* Door-based scale: 15–20 % off when doors are narrower than 0.85 m, and unbounded when it rests on one (possibly false)
  door. The confidence was 0.45 in that case, but the plan was still built at that scale.
* Confidence flags miss most false detections (6 of 15 flagged).
* No OCR: room names and written dimensions are not read, so every room is "Room N" until renamed.
