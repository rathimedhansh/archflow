"""Intermediate data passed between the CV stages.

Every stage returns one of these plain, immutable records, so each stage can be tested on
its own and the pipeline can report what it found at every step. Coordinates are in
*working-image pixels* (see `Preprocessed.factor` to map back to the uploaded image).
"""

from dataclasses import dataclass, field
from typing import Literal

import numpy as np

Orientation = Literal["h", "v"]


class Unsupported(Exception):
    """The drawing is outside the supported style; carries a user-facing reason."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class Preprocessed:
    gray: np.ndarray  # uint8, working resolution
    ink: np.ndarray  # uint8 mask, 255 = drawing ink
    # More sensitive mask that also keeps faint thin lines (door arcs, window lines) that a
    # blurred or light scan renders grey; used only for symbol evidence, never for walls.
    symbols: np.ndarray
    factor: float  # source px = working px * factor
    ink_ratio: float
    inverted: bool
    # 2×3 affine taking deskewed working coordinates back to (unrotated) working coordinates;
    # None when the image was not rotated.
    to_image: np.ndarray | None = None
    skew_deg: float = 0.0
    warnings: tuple[str, ...] = ()

    def to_source(self, x: float, y: float) -> tuple[float, float]:
        """Working (possibly deskewed) pixel coordinates -> uploaded-image pixel coordinates."""
        if self.to_image is not None:
            m = self.to_image
            x, y = m[0, 0] * x + m[0, 1] * y + m[0, 2], m[1, 0] * x + m[1, 1] * y + m[1, 2]
        return x * self.factor, y * self.factor


@dataclass(frozen=True)
class WallSegment:
    """An axis-aligned wall as a centreline. For "h": y = `center`, x from `start` to `end`."""

    id: str
    orientation: Orientation
    center: float
    start: float
    end: float
    thickness: float
    confidence: float

    @property
    def length(self) -> float:
        return self.end - self.start

    def endpoints(self) -> tuple[tuple[float, float], tuple[float, float]]:
        if self.orientation == "h":
            return (self.start, self.center), (self.end, self.center)
        return (self.center, self.start), (self.center, self.end)


@dataclass(frozen=True)
class Gap:
    """A break between two collinear wall pieces that now form one wall: a candidate opening.

    `start`/`end` are positions along the wall's axis (px); `wall_id` is the merged wall.
    """

    wall_id: str
    orientation: Orientation
    center: float
    start: float
    end: float
    thickness: float

    @property
    def width(self) -> float:
        return self.end - self.start


@dataclass(frozen=True)
class WallDetection:
    thickness_px: float  # dominant wall thickness
    min_thickness_px: int  # strokes thinner than this are not walls
    walls: tuple[WallSegment, ...]
    gaps: tuple[Gap, ...]
    wall_mask: np.ndarray  # uint8, 255 = wall
    unexplained_ratio: float  # thick ink not explained by axis-aligned walls (diagonals, curves, blobs)
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class RoomRegion:
    id: str
    polygon: tuple[tuple[float, float], ...]
    area_px: float
    confidence: float


@dataclass(frozen=True)
class RoomDetection:
    rooms: tuple[RoomRegion, ...]
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class Opening:
    kind: Literal["door", "window", "unknown"]
    gap: Gap
    confidence: float
    evidence: str


@dataclass(frozen=True)
class OpeningDetection:
    doors: tuple[Opening, ...]
    windows: tuple[Opening, ...]
    unknown: tuple[Opening, ...]
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class ScaleEstimate:
    meters_per_pixel: float  # per *source* image pixel
    source: Literal["doors", "assumed"]
    confidence: float
    detail: str


@dataclass
class StageResult:
    name: str
    label: str
    summary: str
    ms: float
    warnings: list[str] = field(default_factory=list)
