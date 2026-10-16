# Real-world evaluation images

Images here are kept local and **not versioned** (see the root `.gitignore`). The first two were
uploaded through the app during development (they came from `backend/storage/`) and their licence is
unknown; their ground truth lives in code in `evaluation/cases.py`, so it is versioned. If an image is
missing, its case is skipped and the report says so.

| File | What it is | Ground truth |
|---|---|---|
| `apartment-1.png` | 638×480 marketing-style apartment plan: thin solid walls, double-line windows, door arcs, a bifold balcony door, furniture, dimensions in feet and inches | Traced by hand from pixel measurements (walls, 4 rooms, 4 doors, 7 windows, scale from the written dimensions) |
| `render-3d.png` | 1530×892 3D rendering of a house (not a floor plan) | Nothing should be detected: the correct outcome is a rejection |

## Real-world validation set (2026-09-27)

Five openly licensed plans from Wikimedia Commons, used for the end-to-end validation in
[`docs/REAL_WORLD_VALIDATION.md`](../../../docs/REAL_WORLD_VALIDATION.md). They are not (yet) cases in
`evaluation/cases.py`: their results were judged against the drawings by hand, not by the metrics code.
Images wider than 1920 px were downloaded as Commons' 1920 px rendition.

| File | Commons file | Licence |
|---|---|---|
| `india-2bhk-colour.png` | [2 bhk Bungalow floor plan.jpg](https://commons.wikimedia.org/wiki/File:2_bhk_Bungalow_floor_plan.jpg) | CC BY-SA 4.0 |
| `berlin-p2-grey.png` | [Grundriss Plattenbau P2.JPG](https://commons.wikimedia.org/wiki/File:Grundriss_Plattenbau_P2.JPG) | CC BY-SA 3.0 |
| `spain-cad-diagonal.png` | [Alayoutofthe14x8mgroundfloorhouseplanwith3bhkcaddrawingisgivenFriJul2022082251.webp](https://commons.wikimedia.org/wiki/File:Alayoutofthe14x8mgroundfloorhouseplanwith3bhkcaddrawingisgivenFriJul2022082251.webp) (converted to PNG) | CC BY-SA 4.0 |
| `us-cad-hatched.png` | [Sample Floorplan.jpg](https://commons.wikimedia.org/wiki/File:Sample_Floorplan.jpg) | Public domain |
| `habs-survey.png` | [Floor Plan - 9791 State Route 124 (House) … HABS GA-2422 (sheet 1 of 1).png](https://commons.wikimedia.org/wiki/File:Floor_Plan_-_9791_State_Route_124_(House),_9791_State_Route_124,_Braselton,_Jackson_County,_GA_HABS_GA-2422_(sheet_1_of_1).png) | Public domain (HABS, US National Park Service) |
