"""POST /interpret (streamed progress) and GET /interpretation."""

import json

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api.floorplans import get_store
from app.main import app
from app.storage.floorplans import FloorPlanStore
from evaluation.synth import Style, generate


@pytest.fixture
def store(tmp_path):
    s = FloorPlanStore(tmp_path)
    app.dependency_overrides[get_store] = lambda: s
    yield s
    app.dependency_overrides.clear()


@pytest.fixture
def client(store):
    return TestClient(app)


def upload(client, image: np.ndarray) -> str:
    ok, png = cv2.imencode(".png", image)
    res = client.post("/api/floorplans", files={"file": ("plan.png", png.tobytes(), "image/png")})
    assert res.status_code == 201
    return res.json()["id"]


def stream(client, plan_id: str) -> list[dict]:
    res = client.post(f"/api/floorplans/{plan_id}/interpret")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/x-ndjson")
    return [json.loads(line) for line in res.text.splitlines() if line]


def test_interpret_streams_stages_then_a_valid_plan(client):
    plan_id = upload(client, generate(3, Style()).image)
    lines = stream(client, plan_id)
    stages = [(m["stage"], m["status"]) for m in lines if m["type"] == "stage"]
    assert stages[0] == ("preprocess", "started") and stages[-1] == ("assemble", "done")
    assert len(stages) == 12
    result = lines[-1]
    assert result["type"] == "result"
    plan, report = result["interpretation"]["plan"], result["interpretation"]["report"]
    assert report["supported"] is True and plan["provenance"] == "opencv"
    assert plan["walls"] and plan["rooms"] and plan["doors"] and plan["windows"]
    assert plan["source"]["floorplan_id"] == plan_id


def test_result_is_a_proposal_that_saves_through_normal_validation(client):
    plan_id = upload(client, generate(3, Style()).image)
    proposal = stream(client, plan_id)[-1]["interpretation"]
    # Nothing is saved as the user's plan until they save it in the editor.
    assert client.get(f"/api/floorplans/{plan_id}/structure").json()["walls"] == []
    assert client.get(f"/api/floorplans/{plan_id}/interpretation").json() == proposal
    # The proposal passes the exact validation a hand-drawn plan goes through.
    saved = client.put(f"/api/floorplans/{plan_id}/structure", json=proposal["plan"])
    assert saved.status_code == 200
    assert client.get(f"/api/floorplans/{plan_id}/structure").json() == proposal["plan"]


def test_unsupported_image_gives_an_explained_empty_result(client):
    plan_id = upload(client, np.full((600, 800), 255, np.uint8))
    result = stream(client, plan_id)[-1]
    assert result["type"] == "result"
    report = result["interpretation"]["report"]
    assert report["supported"] is False and "blank" in report["reason"]
    assert result["interpretation"]["plan"]["walls"] == []


def test_unknown_or_bad_ids(client):
    assert client.post("/api/floorplans/" + "0" * 32 + "/interpret").status_code == 404
    assert client.post("/api/floorplans/..%2F..%2Fetc/interpret").status_code == 404
    assert client.get("/api/floorplans/" + "0" * 32 + "/interpretation").status_code == 404


def test_interpretation_404_before_running(client):
    plan_id = upload(client, generate(3, Style()).image)
    res = client.get(f"/api/floorplans/{plan_id}/interpretation")
    assert res.status_code == 404 and res.json()["error"]["code"] == "not_found"


def test_damaged_stored_interpretation_is_a_clean_422(client, store):
    plan_id = upload(client, generate(3, Style()).image)
    store.save_interpretation(plan_id, '{"plan": {"version": 1}, "report": "nope"}')
    res = client.get(f"/api/floorplans/{plan_id}/interpretation")
    assert res.status_code == 422 and res.json()["error"]["code"] == "invalid_structure"


def test_failure_after_stream_start_is_reported_in_band(client, store, monkeypatch):
    plan_id = upload(client, generate(3, Style()).image)

    def disk_full(*_args):
        raise OSError("disk full")

    monkeypatch.setattr(store, "save_interpretation", disk_full)
    lines = stream(client, plan_id)
    assert lines[-1]["type"] == "error" and "by hand" in lines[-1]["message"]
