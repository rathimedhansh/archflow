# Supported floor plans (automatic detection, pipeline `opencv-1`)

ARCHFLOW's automatic detection is **classical computer vision** (OpenCV, no machine learning).
It does not understand architectural drawings in general. It reliably reads **one common drawing
style**, described below, and says so when an image is outside it. Anything it produces is a
*proposal* that the user reviews and corrects in the editor. Measured results are in
[CV_EVALUATION.md](CV_EVALUATION.md); an end-to-end test on five real plans is in
[REAL_WORLD_VALIDATION.md](REAL_WORLD_VALIDATION.md).

## Supported input

| Aspect | Supported |
|---|---|
| File | PNG or JPEG, up to 15 MB and **20 megapixels** (width × height, e.g. 5000 × 4000 px; an A3 scan at 300 dpi fits, A2 at 300 dpi does not). The image is decoded by content and normalised to PNG. Larger images are refused with their size in the message: scale them down first. |
| Resolution | Any size up to the limit is accepted for upload. For detection, **interior walls should be at least ~4 px thick** in the image. In practice that means about **50 px per metre or more**, usually 800 px or more on the long side for a typical flat. Smaller images get a "low resolution" warning. Large images are processed at up to 2000 px on the long side. |
| Drawing type | A single-storey **2D plan view** (looking straight down). One floor per image. The plan may be cropped tightly (walls touching the image edge). |
| Colours | Dark lines on a light background (black on white is best). Light-on-dark (blueprint) drawings are inverted automatically. Mild scanner noise, blur and JPEG artefacts are tolerated. |
| Walls | **Solid, filled strokes** that are clearly **thicker than every other line** (text, dimensions, furniture, symbols). They must be **horizontal or vertical**. A scan tilted by up to 10° is straightened automatically. |
| Doors | A gap in the wall with a **quarter-circle swing arc** (single leaf, either side, either hinge), or two half-width arcs (double door). A single threshold line drawn across the door gap is fine. |
| Windows | A gap in the wall (or a light band inside the wall) bridged by **thin lines running along the wall**: the usual 2- or 3-line window symbol. |
| Rooms | Areas fully enclosed by walls, doors and windows. Rooms are outlines on the wall centrelines, which is the same convention as tracing by hand in the editor. |
| Annotation | Room names, dimension lines, furniture outlines and hatching-free symbols are fine as long as they are thinner than the walls. |

## Scale

A drawing has no inherent scale, and the pipeline has **no OCR**, so it cannot read written
dimensions. When doors are detected, the scale is **estimated from their median width, assuming a
standard 0.85 m door**, and checked for plausibility (walls must come out 5–80 cm thick).
Otherwise it falls back to the manual editor's assumption (the image is about 12 m wide).
Either way the plan is saved as **uncalibrated**. The editor asks the user to set the real scale
from a known dimension.

## Not supported (and what happens)

| Input | Result |
|---|---|
| Walls drawn as two thin outlines (hollow), or hatched walls | Rejected with an explanation |
| 3D renderings, photos, shaded/coloured drawings, dark backgrounds | Rejected (not a line drawing / too much dark area) |
| Blank or almost-empty images, unreadable/corrupted files | Rejected with an explanation |
| Drawings rotated by more than 10° | Rejected ("upload it straight") |
| Diagonal or curved walls | Not detected. A warning appears when a large share of the thick lines is unexplained. The rest of the plan is still proposed. |
| Doors without a swing arc (plain gaps, sliding, pocket, bifold/folding doors), and doors drawn partly open | Left as an **unidentified opening**: the wall is split there, no door is invented |
| Very wide openings (more than about 16 wall thicknesses, e.g. a bifold wall in a thin-wall drawing) | Treated as open space. The room behind it can "leak" to the outside and is then **not detected**. |
| Spaces bounded by railings or thin lines only (balconies, terraces) | Not rooms (no walls) |
| Rooms with islands (columns, stair cores) | The room is kept; the island is not cut out (warning) |
| Thick drawing frames / title blocks | Mostly ignored when they enclose the whole plan. Can still produce extra walls (see evaluation). |
| Very low resolution (walls thinner than ~4 px) | Thin walls are missed, rooms merge |
| Multi-storey sheets, sections, elevations, site plans | Not supported: results are meaningless |
| Written dimensions and room names | Not read (no OCR). Rooms are named "Room 1…". |

## Confidence

Each detected element carries a heuristic score in [0, 1] (for example, how much of a door arc was
found, or whether a wall's ends connect to other walls). **These are not calibrated probabilities.**
Elements below 0.5 are left out. Elements below 0.7 are flagged "needs review" in the editor.
Important: the score describes what **was** detected, not what was **missed**. On the real test
plan every detected element scored at least 0.75, even though a whole room and three doors were
missed. Missed elements show up only as warnings (for example "4 wall openings could not be
identified", or "36% of the thick line work was not recognised").
