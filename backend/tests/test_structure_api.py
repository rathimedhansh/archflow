import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.api.floorplans import get_store
from app.main import app
from app.storage.floorplans import FloorPlanStore


@pytest.fixture
def client(tmp_path):
    store = FloorPlanStore(tmp_path)
    app.dependency_overrides[get_store] = lambda: store
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture
def plan_id(client):
    buf = io.BytesIO()
    Image.new("RGB", (1000, 800), "white").save(buf, format="PNG")
    res = client.post("/api/floorplans", files={"file": ("p.png", buf.getvalue(), "image/png")})
    return res.json()["id"]


def test_get_returns_empty_uncalibrated_plan_first(client, plan_id):
    res = client.get(f"/api/floorplans/{plan_id}/structure")
    assert res.status_code == 200
    body = res.json()
    assert body["walls"] == [] and body["rooms"] == []
    assert body["scale"]["calibrated"] is False
    assert body["source"] == {"floorplan_id": plan_id, "width_px": 1000, "height_px": 800}
    assert body["provenance"] == "manual"


def valid_body(plan_id, **extra):
    body = {
        "source": {"floorplan_id": plan_id, "width_px": 1000, "height_px": 800},
        "scale": {"meters_per_pixel": 0.012, "calibrated": True},
        "walls": [{"id": "wall-1", "start": [1, 1], "end": [6, 1]}],
        "rooms": [{"id": "room-1", "name": "Hall", "polygon": [[1, 1], [6, 1], [6, 5], [1, 5]]}],
        "doors": [{"id": "door-1", "wall_id": "wall-1", "offset": 2}],
    }
    body.update(extra)
    return body


def test_put_then_get_persists(client, plan_id):
    res = client.put(f"/api/floorplans/{plan_id}/structure", json=valid_body(plan_id))
    assert res.status_code == 200
    got = client.get(f"/api/floorplans/{plan_id}/structure").json()
    assert got["scale"]["calibrated"] is True
    assert got["walls"][0]["id"] == "wall-1" and got["rooms"][0]["name"] == "Hall"


def test_put_invalid_plan_rejected_and_not_saved(client, plan_id):
    bad = valid_body(plan_id, doors=[{"id": "d", "wall_id": "ghost", "offset": 0}])
    res = client.put(f"/api/floorplans/{plan_id}/structure", json=bad)
    assert res.status_code == 422
    assert "unknown wall" in str(res.json())
    assert client.get(f"/api/floorplans/{plan_id}/structure").json()["walls"] == []


def test_put_rejects_mismatched_source(client, plan_id):
    body = valid_body(plan_id)
    body["source"]["width_px"] = 999
    assert client.put(f"/api/floorplans/{plan_id}/structure", json=body).status_code == 422
    body = valid_body("b" * 32)
    assert client.put(f"/api/floorplans/{plan_id}/structure", json=body).status_code == 422


@pytest.mark.parametrize("content", ["{not json", '{"version": 1, "walls": "oops"}', '{"version": 99}', ""])
def test_corrupt_saved_structure_is_a_clean_422(client, plan_id, content):
    # Bypass the API's validation, as a damaged or hand-edited file on disk would.
    app.dependency_overrides[get_store]().save_structure(plan_id, content)
    res = client.get(f"/api/floorplans/{plan_id}/structure")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "invalid_structure"
    assert "damaged" in res.json()["error"]["message"]


def test_unknown_plan_404(client):
    assert client.get("/api/floorplans/" + "0" * 32 + "/structure").status_code == 404
    assert client.put("/api/floorplans/bad-id/structure", json={}).status_code in (404, 422)
