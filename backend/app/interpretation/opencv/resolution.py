"""Stages 2-3: find walls and rooms, choosing how to read the drawing.

1. Solid walls at the native resolution (the normal case).
2. Small images: also enlarged ×2/×3, when that is clearly more coherent (below).
3. Only if no solid reading works: walls drawn as double outlines (`hollow.py`), accepted only when
   they form a connected network around rooms, and always reported with reduced confidence.

Small images (step 2):

Many floor plans found online are small (300-1000 px), so walls are only 2-3 px thick, no
thicker than the text and dimension lines the wall detector must ignore. At the native size
such a plan is either rejected ("no thick walls") or its thin interior walls are silently
lost (rooms merge). Upscaling every image is *not* a fix: on drawings that are already
readable it thickens annotation lines into false walls.

So small images are read under up to three hypotheses (native, ×2, ×3), and an enlarged
reading replaces the native one only when it is clearly more coherent by the detector's own
evidence (no ground truth): it must find more rooms while its walls stay as well connected
(see `_better`). Deterministic; the extra work is bounded because only images up to
UPSCALE_MAX_SIDE are tried and the working image never exceeds MAX_WORKING_SIDE.
"""

from dataclasses import dataclass, replace

import numpy as np

from app.interpretation.opencv.hollow import hollow_inputs
from app.interpretation.opencv.openings import detect_openings
from app.interpretation.opencv.preprocess import MAX_WORKING_SIDE, MIN_RECOMMENDED_SIDE, preprocess
from app.interpretation.opencv.rooms import detect_rooms
from app.interpretation.opencv.types import Gap, Preprocessed, RoomDetection, Unsupported, WallDetection, WallSegment
from app.interpretation.opencv.walls import detect_walls

UPSCALE_MAX_SIDE = MAX_WORKING_SIDE // 2  # larger images already have enough pixels per wall
UPSCALES = (2.0, 3.0)
# Below this the whole plan is a thumbnail: walls, text and symbols are the same 1-2 px blur and
# no resolution trick can separate them reliably (measured: enlarged thumbnails read text as walls).
MIN_DETECT_SIDE = 320
KEPT = 0.5  # same as assemble.OMIT_BELOW: elements below it never reach the plan
FREE_END_SCORE = 0.9  # a wall scores below this when one of its ends meets no other wall (walls.py)
# Acceptance thresholds for an enlarged reading (see `_better`).
MIN_WALL_SCORE = 0.95  # replacing a native reading: walls must stay this well connected
MIN_WALL_SCORE_RESCUE = 0.8  # replacing a rejection: still mostly connected walls
MIN_ROOMS_RESCUE = 2
# A building's walls form one connected network; dimension lines and furniture read as walls do not.
MIN_CONNECTED_RESCUE = 0.9
# A hollow (double-line) reading reconstructs walls, so it is never reported as confidently as solid walls.
HOLLOW_MIN_WALL_SCORE = 0.85
HOLLOW_CONFIDENCE = 0.75  # at most "medium"
HOLLOW_UNCERTAIN_CONFIDENCE = 0.55  # "uncertain" (below the UI's 0.6 band)
HOLLOW_MAX_FREE_END_SHARE = 0.2  # walls ending without meeting another wall
HOLLOW_MIN_COVERAGE = 0.5  # share of the building enclosed by rooms
# In a double-line reading a long gap must show a door or window: unrelated collinear walls (a corner of the
# building and a wall across the room) are otherwise joined through an "opening" that crosses a room.
HOLLOW_PLAIN_GAP_MAX = 8  # wall thicknesses: wider than any door
HOLLOW_ARC_EVIDENCE = 0.4  # door-arc score below which a gap shows no door at all (a door scores >= 0.6)


@dataclass(frozen=True)
class Reading:
    pre: Preprocessed
    walls: WallDetection
    rooms: RoomDetection
    upscale: float = 1.0
    note: str | None = None  # why the image was read enlarged or as double-line walls
    confidence_cap: float = 1.0  # the overall confidence of a plan from this reading is at most this

    @property
    def warnings(self) -> tuple[str, ...]:
        """The wall stage's warnings (the room stage reports its own)."""
        return self.walls.warnings + ((self.note,) if self.note else ())

    @property
    def wall_score(self) -> float:
        """Mean confidence of the walls that will be kept (mostly: are their ends connected?)."""
        kept = [w.confidence for w in self.walls.walls if w.confidence >= KEPT]
        return float(np.mean(kept)) if kept else 0.0

    @property
    def room_count(self) -> int:
        return sum(1 for r in self.rooms.rooms if r.confidence >= KEPT)

    @property
    def connected_share(self) -> float:
        """Share of the kept wall length in the largest group of walls that touch each other."""
        kept = [w for w in self.walls.walls if w.confidence >= KEPT]
        if not kept:
            return 0.0
        group = list(range(len(kept)))

        def root(i: int) -> int:
            while group[i] != i:
                group[i] = group[group[i]]
                i = group[i]
            return i

        def touches(a: WallSegment, b: WallSegment) -> bool:
            """An end of `a` lies on `b` (snapped junctions put it on b's centreline)."""
            tol = (a.thickness + b.thickness) / 2 + 1
            for x, y in a.endpoints():
                along, across = (x, y) if b.orientation == "h" else (y, x)
                if abs(across - b.center) <= tol and b.start - tol <= along <= b.end + tol:
                    return True
            return False

        for i, a in enumerate(kept):
            for j in range(i + 1, len(kept)):
                if touches(a, kept[j]) or touches(kept[j], a):
                    group[root(i)] = root(j)
        length: dict[int, float] = {}
        for i, w in enumerate(kept):
            length[root(i)] = length.get(root(i), 0.0) + w.length
        return max(length.values()) / sum(length.values())

    @property
    def coverage(self) -> float:
        """Share of the walls' bounding box covered by rooms (independent of the working scale)."""
        kept = [w for w in self.walls.walls if w.confidence >= KEPT]
        if not kept:
            return 0.0
        xs = [p[0] for w in kept for p in w.endpoints()]
        ys = [p[1] for w in kept for p in w.endpoints()]
        box = (max(xs) - min(xs)) * (max(ys) - min(ys))
        area = sum(r.area_px for r in self.rooms.rooms if r.confidence >= KEPT)
        return area / box if box > 0 else 0.0


def _read(image: np.ndarray, upscale: float, pre: Preprocessed | None = None) -> Reading:
    pre = pre or preprocess(image, upscale)
    walls = detect_walls(pre)
    return Reading(pre, walls, detect_rooms(pre, walls), upscale)


def _better(candidate: Reading, native: Reading | None) -> bool:
    if native is None:
        # The native reading was rejected: only accept a clearly plan-like result. Enlarging thickens every
        # line, so the drawing must still show a separate thin-line class (text, symbols) next to the walls;
        # with a single line weight (graph paper, a blurred thumbnail) "walls" would be everything.
        return (candidate.walls.thin_px is not None and candidate.room_count >= MIN_ROOMS_RESCUE
                and candidate.wall_score >= MIN_WALL_SCORE_RESCUE and candidate.connected_share >= MIN_CONNECTED_RESCUE)
    return (
        candidate.room_count > native.room_count
        and candidate.wall_score >= max(MIN_WALL_SCORE, native.wall_score - 0.02)
        and candidate.connected_share >= native.connected_share - 0.02
        and candidate.coverage >= native.coverage - 0.05
    )


def _solid_reading(image: np.ndarray, pre: Preprocessed) -> Reading:
    """Walls and rooms at the best working resolution. `pre` is the native preprocessing.

    Raises `Unsupported` with the native reason when no reading works."""
    side = max(image.shape[:2])
    try:
        native: Reading | None = _read(image, 1.0, pre)
        failure: Unsupported | None = None
    except Unsupported as exc:
        native, failure = None, exc
    if side > UPSCALE_MAX_SIDE:
        if failure:
            raise failure
        return native  # type: ignore[return-value]
    if native is None and side < MIN_DETECT_SIDE:
        h, w = image.shape[:2]
        raise Unsupported(
            f"The image is too small ({w}×{h} px) to tell walls apart from text and symbols. "
            f"Upload a larger version of the plan ({MIN_RECOMMENDED_SIDE} px or more on the long side)."
        )
    if side >= MIN_DETECT_SIDE:
        for s in UPSCALES:
            if side * s > MAX_WORKING_SIDE + 1:
                break
            try:
                candidate = _read(image, s)
            except Unsupported:
                continue
            if _better(candidate, native):
                note = (f"Walls in this image are only about {candidate.walls.thickness_px / s:.0f} px thick, so it was "
                        f"analysed at {s:g}× size. Small images are less reliable: check the result against the plan.")
                return Reading(candidate.pre, candidate.walls, candidate.rooms, s, note)
    if native is None:
        assert failure is not None
        if side < MIN_RECOMMENDED_SIDE:
            h, w = image.shape[:2]
            raise Unsupported(f"{failure.reason} The image is also small ({w}×{h} px): if its walls are solid lines, "
                              f"a larger version ({MIN_RECOMMENDED_SIDE} px or more on the long side) may work.")
        raise failure
    return native


def _split_unexplained_gaps(pre: Preprocessed, walls: WallDetection) -> WallDetection:
    """Split walls at long gaps that show neither a door arc nor window lines (double-line readings only).

    Each piece loses the connection at that end, so its confidence drops like that of any wall with a free end."""
    plain = {(o.gap.wall_id, o.gap.start, o.gap.end) for o in detect_openings(pre, walls).unknown
             if o.gap.width > HOLLOW_PLAIN_GAP_MAX * walls.thickness_px and o.confidence < HOLLOW_ARC_EVIDENCE}
    if not plain:
        return walls
    pieces: list[tuple[WallSegment, list[Gap]]] = []
    for w in walls.walls:
        own = sorted((g for g in walls.gaps if g.wall_id == w.id), key=lambda g: g.start)
        cuts = [g for g in own if (w.id, g.start, g.end) in plain]
        bounds = [w.start] + [v for g in cuts for v in (g.start, g.end)] + [w.end]
        for i in range(0, len(bounds), 2):
            a, b = bounds[i], bounds[i + 1]
            if b - a < w.thickness:
                continue  # nothing left of the wall on this side of the gap
            free = (i > 0) + (i + 2 < len(bounds))
            piece = replace(w, start=a, end=b, confidence=round(w.confidence - 0.175 * free, 3))
            pieces.append((piece, [g for g in own if g not in cuts and a <= g.start and g.end <= b]))
    pieces.sort(key=lambda p: (p[0].orientation != "h", round(p[0].center, 3), p[0].start))  # same order as walls.py
    final, gaps = [], []
    for n, (w, own) in enumerate(pieces):
        final.append(replace(w, id=f"w{n}"))
        gaps.extend(replace(g, wall_id=f"w{n}") for g in own)
    return replace(walls, walls=tuple(final), gaps=tuple(gaps))


def _hollow_reading(pre: Preprocessed) -> Reading:
    """Walls drawn as double outlines, reconstructed by `hollow.py`, at the native working resolution."""
    for_walls, later = hollow_inputs(pre)
    walls = _split_unexplained_gaps(later, detect_walls(for_walls))
    reading = Reading(later, walls, detect_rooms(later, walls))
    if not (reading.room_count >= MIN_ROOMS_RESCUE and reading.wall_score >= HOLLOW_MIN_WALL_SCORE
            and reading.connected_share >= MIN_CONNECTED_RESCUE):
        raise Unsupported("the double lines do not form a connected network of walls around rooms")
    kept = [w for w in walls.walls if w.confidence >= KEPT]
    free = sum(1 for w in kept if w.confidence < FREE_END_SCORE)
    note = ("The walls are drawn as double outlines; they were reconstructed from the line pairs, which is less "
            "reliable than solid walls. Check every wall against the drawing.")
    cap = HOLLOW_CONFIDENCE
    if free > HOLLOW_MAX_FREE_END_SHARE * len(kept) or reading.coverage < HOLLOW_MIN_COVERAGE:
        cap = HOLLOW_UNCERTAIN_CONFIDENCE
        why = []
        if free:
            why.append(f"{free} wall{'s end' if free != 1 else ' ends'} without meeting another wall")
        if reading.coverage < HOLLOW_MIN_COVERAGE:
            why.append(f"rooms enclose only about {round(reading.coverage * 100)}% of the building")
        note += f" {' and '.join(why).capitalize()}: walls may be missing, so rooms may be merged or missing."
    return replace(reading, note=note, confidence_cap=cap)


def read_walls_and_rooms(image: np.ndarray, pre: Preprocessed) -> Reading:
    """Walls and rooms: solid walls first (at the best resolution), then double-line walls.

    The double-line reading is only tried when no solid reading works, so plans that already
    convert are never affected. Raises `Unsupported` with the solid reading's reason otherwise."""
    try:
        return _solid_reading(image, pre)
    except Unsupported as exc:
        if max(image.shape[:2]) < MIN_DETECT_SIDE:
            raise
        try:
            return _hollow_reading(pre)
        except Unsupported:
            raise Unsupported(f"{exc.reason} Walls drawn as double outlines were looked for too, but could not be "
                              "traced into a reliable plan.") from None
