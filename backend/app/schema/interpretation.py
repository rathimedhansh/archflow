"""What an automatic interpreter says about its own result.

Kept separate from the FloorPlan on purpose: the FloorPlan stays the single, unchanged
contract for the editor and the 3D engine, while this report carries the machine's
uncertainty (confidence per element, warnings, scale source) for human review.

Confidence values are heuristic scores in [0, 1] from the detector's own evidence (for
example how much of a door arc was found). They are not calibrated probabilities.
"""

from typing import Literal

from pydantic import BaseModel, Field

from app.schema.floorplan import FloorPlan

ElementKind = Literal["wall", "room", "door", "window"]


class _Base(BaseModel):
    model_config = {"extra": "forbid"}


class ElementConfidence(_Base):
    id: str
    kind: ElementKind
    confidence: float = Field(ge=0, le=1)
    evidence: str = ""
    needs_review: bool = False


class StageReport(_Base):
    name: str
    label: str
    summary: str
    ms: float = Field(ge=0)


class ScaleReport(_Base):
    meters_per_pixel: float = Field(gt=0)
    source: Literal["doors", "assumed"]
    confidence: float = Field(ge=0, le=1)
    detail: str


class InterpretationReport(_Base):
    interpreter: Literal["opencv"] = "opencv"
    pipeline_version: str
    supported: bool
    # Why the drawing is unsupported (when `supported` is false).
    reason: str | None = None
    overall_confidence: float = Field(ge=0, le=1)
    stages: list[StageReport] = Field(default_factory=list)
    elements: list[ElementConfidence] = Field(default_factory=list)
    scale: ScaleReport | None = None
    warnings: list[str] = Field(default_factory=list)
    # Candidate elements the detector saw but left out because the evidence was too weak.
    omitted: dict[str, int] = Field(default_factory=dict)


class Interpretation(_Base):
    plan: FloorPlan
    report: InterpretationReport
