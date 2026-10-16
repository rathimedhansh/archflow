from pathlib import Path

from app.schema import FloorPlan, Scale, SourceImage
from app.storage.floorplans import FloorPlanRecord

# Until the user calibrates, assume the image spans this many metres. It only
# needs to be plausible enough that the editor feels sensible; `calibrated`
# stays False so nothing pretends it is a measurement.
ASSUMED_IMAGE_WIDTH_M = 12.0


class ManualInterpreter:
    """Starts every plan empty; the user traces walls and rooms in the editor."""

    name = "manual"

    def interpret(self, image_path: Path, record: FloorPlanRecord) -> FloorPlan:
        return FloorPlan(
            provenance="manual",
            source=SourceImage(
                floorplan_id=record.id, width_px=record.width, height_px=record.height
            ),
            scale=Scale(meters_per_pixel=ASSUMED_IMAGE_WIDTH_M / record.width, calibrated=False),
        )
