from pathlib import Path
from typing import Protocol

from app.schema import FloorPlan
from app.storage.floorplans import FloorPlanRecord


class Interpreter(Protocol):
    """Turns a prepared floor-plan image into a structured FloorPlan.

    Implementations must return a plan that validates against the schema. Machine
    interpreters should set `provenance` so the UI can ask a human to review.
    """

    name: str

    def interpret(self, image_path: Path, record: FloorPlanRecord) -> FloorPlan: ...
