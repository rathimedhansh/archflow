"""Property projects and public share links (Milestone 7)."""

import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.api.floorplans import get_store
from app.api.projects import get_project_store
from app.main import app
from app.storage.floorplans import FloorPlanStore
from app.storage.projects import ProjectStore


@pytest.fixture
def stores(tmp_path):
    return FloorPlanStore(tmp_path), ProjectStore(tmp_path)


@pytest.fixture
def client(stores):
    plans, projects = stores
    app.dependency_overrides[get_store] = lambda: plans
    app.dependency_overrides[get_project_store] = lambda: projects
    yield TestClient(app)
    app.dependency_overrides.clear()


def upload(client) -> str:
    buf = io.BytesIO()
    Image.new("RGB", (1000, 800), "white").save(buf, format="PNG")
    res = client.post("/api/floorplans", files={"file": ("plan.png", buf.getvalue(), "image/png")})
    assert res.status_code == 201
    return res.json()["id"]


def plan_body(floorplan_id: str, *, calibrated=True, name="Living room", wall_height=2.8) -> dict:
    return {
        "provenance": "opencv",
        "source": {"floorplan_id": floorplan_id, "width_px": 1000, "height_px": 800},
        "scale": {"meters_per_pixel": 0.01, "calibrated": calibrated},
        "walls": [{"id": "wall-1", "start": [1, 1], "end": [6, 1], "height": wall_height, "thickness": 0.2}],
        "rooms": [{"id": "room-1", "name": name, "polygon": [[1, 1], [6, 1], [6, 5], [1, 5]]}],
        "doors": [{"id": "door-1", "wall_id": "wall-1", "offset": 1, "width": 0.9, "height": 2.1}],
        "windows": [],
    }


def new_project(client, **body) -> dict:
    res = client.post("/api/projects", json={"name": "Harbour View 12", **body})
    assert res.status_code == 201, res.text
    return res.json()


def project_with_saved_plan(client, **plan_kw) -> tuple[dict, str]:
    p = new_project(client, address="12 Quay Street", description="Two bedrooms, sea view.")
    fid = upload(client)
    assert client.put(f"/api/projects/{p['id']}/floorplan", json={"floorplan_id": fid}).status_code == 200
    assert client.put(f"/api/floorplans/{fid}/structure", json=plan_body(fid, **plan_kw)).status_code == 200
    return client.get(f"/api/projects/{p['id']}").json(), fid


# ---- project management --------------------------------------------------------------------

def test_create_and_get_project(client):
    p = new_project(client, address="  12   Quay Street ", description="  Sea view.\nTwo bedrooms.  ")
    assert p["name"] == "Harbour View 12" and p["address"] == "12 Quay Street"
    assert p["description"] == "Sea view.\nTwo bedrooms."  # line breaks kept in the description
    assert p["floorplan"] is None and p["plan"] is None and p["share"] is None
    assert len(p["id"]) == 32
    assert client.get(f"/api/projects/{p['id']}").json() == p


@pytest.mark.parametrize("body", [{"name": ""}, {"name": "   "}, {"name": "x" * 121}, {}, {"name": "ok", "address": "a" * 201},
                                  {"name": "ok", "owner": "someone"}])
def test_invalid_project_is_rejected(client, body):
    assert client.post("/api/projects", json=body).status_code == 422


def test_list_is_most_recently_updated_first(client):
    a = new_project(client, name="A")
    b = new_project(client, name="B")
    assert [p["name"] for p in client.get("/api/projects").json()] == ["B", "A"]
    client.patch(f"/api/projects/{a['id']}", json={"address": "1 Main St"})
    listed = client.get("/api/projects").json()
    assert [p["name"] for p in listed] == ["A", "B"] and listed[0]["address"] == "1 Main St"
    assert b["id"] in {p["id"] for p in listed}


def test_update_only_changes_given_fields(client):
    p = new_project(client, address="Old", description="Keep me")
    res = client.patch(f"/api/projects/{p['id']}", json={"name": "Renamed"})
    body = res.json()
    assert (body["name"], body["address"], body["description"]) == ("Renamed", "Old", "Keep me")
    assert body["updated_at"] >= p["updated_at"]
    assert client.patch(f"/api/projects/{p['id']}", json={"name": ""}).status_code == 422


@pytest.mark.parametrize("bad", ["nope", "../../etc", "0" * 31, "A" * 32])
def test_unknown_or_malformed_project_ids_are_404(client, bad):
    assert client.get(f"/api/projects/{bad}").status_code == 404
    assert client.patch(f"/api/projects/{bad}", json={"name": "x"}).status_code == 404
    assert client.delete(f"/api/projects/{bad}").status_code == 404


def test_damaged_project_record_is_a_clean_error_and_skipped_in_the_list(client, stores):
    p = new_project(client)
    ok = new_project(client, name="Fine")
    (stores[1]._projects / p["id"] / "project.json").write_text("{not json", encoding="utf-8")
    res = client.get(f"/api/projects/{p['id']}")
    assert res.status_code == 422 and res.json()["error"]["code"] == "invalid_structure"
    assert [x["id"] for x in client.get("/api/projects").json()] == [ok["id"]]


# ---- persistent floor plan -------------------------------------------------------------------

def test_attach_floorplan_and_summary_follow_the_saved_plan(client):
    p = new_project(client)
    fid = upload(client)
    res = client.put(f"/api/projects/{p['id']}/floorplan", json={"floorplan_id": fid})
    body = res.json()
    assert body["floorplan"]["id"] == fid and body["floorplan"]["image_url"] == f"/api/floorplans/{fid}/image"
    assert body["plan"] == {**body["plan"], "saved": False, "rooms": 0}
    assert client.get(f"/api/floorplans/{fid}").json()["project_id"] == p["id"]

    client.put(f"/api/floorplans/{fid}/structure", json=plan_body(fid))
    summary = client.get(f"/api/projects/{p['id']}").json()["plan"]
    assert summary["saved"] and summary["calibrated"] and summary["provenance"] == "opencv"
    assert (summary["walls"], summary["rooms"], summary["doors"], summary["windows"]) == (1, 1, 1, 0)
    assert summary["floor_area_m2"] == 20.0 and summary["saved_at"]


def test_attaching_unknown_or_foreign_floorplan_fails(client):
    a, b = new_project(client, name="A"), new_project(client, name="B")
    assert client.put(f"/api/projects/{a['id']}/floorplan", json={"floorplan_id": "0" * 32}).status_code == 404
    fid = upload(client)
    client.put(f"/api/projects/{a['id']}/floorplan", json={"floorplan_id": fid})
    res = client.put(f"/api/projects/{b['id']}/floorplan", json={"floorplan_id": fid})
    assert res.status_code == 409 and res.json()["error"]["code"] == "conflict"


def test_replacing_the_floorplan_unlinks_the_old_one(client):
    p = new_project(client)
    old, new = upload(client), upload(client)
    client.put(f"/api/projects/{p['id']}/floorplan", json={"floorplan_id": old})
    client.put(f"/api/projects/{p['id']}/floorplan", json={"floorplan_id": new})
    assert client.get(f"/api/projects/{p['id']}").json()["floorplan"]["id"] == new
    assert client.get(f"/api/floorplans/{old}").json()["project_id"] is None


def test_project_survives_a_restart(client, stores, tmp_path):
    p, fid = project_with_saved_plan(client)
    fresh = TestClient(app)
    app.dependency_overrides[get_store] = lambda: FloorPlanStore(tmp_path)
    app.dependency_overrides[get_project_store] = lambda: ProjectStore(tmp_path)
    again = fresh.get(f"/api/projects/{p['id']}").json()
    assert again == p
    assert fresh.get(f"/api/floorplans/{fid}/structure").json()["rooms"][0]["name"] == "Living room"


def test_damaged_saved_plan_is_reported_not_raised(client, stores):
    p, fid = project_with_saved_plan(client)
    (stores[0]._root / fid / "structure.json").write_text('{"version": 99}', encoding="utf-8")
    summary = client.get(f"/api/projects/{p['id']}").json()["plan"]
    assert summary["saved"] and summary["damaged"]
    res = client.post(f"/api/projects/{p['id']}/share")
    assert res.status_code == 422


def test_plans_uploaded_without_a_project_still_work(client):
    fid = upload(client)
    assert client.get(f"/api/floorplans/{fid}").json()["project_id"] is None
    assert client.put(f"/api/floorplans/{fid}/structure", json=plan_body(fid)).status_code == 200


def test_delete_project_removes_its_plan_and_share(client, stores):
    p, fid = project_with_saved_plan(client)
    token = client.post(f"/api/projects/{p['id']}/share").json()["share"]["token"]
    assert client.delete(f"/api/projects/{p['id']}").status_code == 204
    assert client.get(f"/api/projects/{p['id']}").status_code == 404
    assert client.get(f"/api/floorplans/{fid}").status_code == 404
    assert client.get(f"/api/share/{token}").status_code == 404
    assert client.get("/api/projects").json() == []


# ---- sharing -----------------------------------------------------------------------------------

def test_share_requires_a_saved_non_empty_plan(client):
    p = new_project(client)
    res = client.post(f"/api/projects/{p['id']}/share")
    assert res.status_code == 409 and "Upload a floor plan" in res.json()["error"]["message"]
    fid = upload(client)
    client.put(f"/api/projects/{p['id']}/floorplan", json={"floorplan_id": fid})
    assert "Save the floor plan" in client.post(f"/api/projects/{p['id']}/share").json()["error"]["message"]
    empty = {**plan_body(fid), "walls": [], "rooms": [], "doors": []}
    client.put(f"/api/floorplans/{fid}/structure", json=empty)
    assert "empty" in client.post(f"/api/projects/{p['id']}/share").json()["error"]["message"]


def test_published_page_is_read_only_and_reveals_nothing_editable(client):
    p, fid = project_with_saved_plan(client)
    share = client.post(f"/api/projects/{p['id']}/share").json()["share"]
    assert share["url_path"] == f"/share/{share['token']}" and share["up_to_date"] is True
    assert len(share["token"]) >= 20

    res = client.get(f"/api/share/{share['token']}")
    assert res.status_code == 200
    body = res.json()
    assert body["property"] == {"name": "Harbour View 12", "address": "12 Quay Street", "description": "Two bedrooms, sea view."}
    assert body["plan"]["rooms"][0]["name"] == "Living room" and body["published_at"]
    text = res.text
    assert fid not in text and p["id"] not in text  # neither the editable plan nor the project can be reached
    assert body["plan"]["source"]["floorplan_id"] == "shared"
    # The public route only reads.
    for method in ("put", "post", "patch", "delete"):
        assert getattr(client, method)(f"/api/share/{share['token']}").status_code == 405


def test_share_is_a_snapshot_until_republished(client):
    p, fid = project_with_saved_plan(client)
    token = client.post(f"/api/projects/{p['id']}/share").json()["share"]["token"]
    client.put(f"/api/floorplans/{fid}/structure", json=plan_body(fid, name="Salon"))
    assert client.get(f"/api/share/{token}").json()["plan"]["rooms"][0]["name"] == "Living room"
    assert client.get(f"/api/projects/{p['id']}").json()["share"]["up_to_date"] is False

    again = client.post(f"/api/projects/{p['id']}/share").json()["share"]
    assert again["token"] == token and again["up_to_date"] is True  # same link, new content
    assert client.get(f"/api/share/{token}").json()["plan"]["rooms"][0]["name"] == "Salon"


def test_renaming_the_project_needs_a_republish_to_reach_buyers(client):
    p, _ = project_with_saved_plan(client)
    token = client.post(f"/api/projects/{p['id']}/share").json()["share"]["token"]
    renamed = client.patch(f"/api/projects/{p['id']}", json={"name": "Harbour View 12A"}).json()
    assert renamed["share"]["up_to_date"] is False
    assert client.get(f"/api/share/{token}").json()["property"]["name"] == "Harbour View 12"
    client.post(f"/api/projects/{p['id']}/share")
    assert client.get(f"/api/share/{token}").json()["property"]["name"] == "Harbour View 12A"


def test_revoking_switches_the_link_off_and_a_new_share_gets_a_new_link(client):
    p, _ = project_with_saved_plan(client)
    token = client.post(f"/api/projects/{p['id']}/share").json()["share"]["token"]
    body = client.delete(f"/api/projects/{p['id']}/share").json()
    assert body["share"] is None
    res = client.get(f"/api/share/{token}")
    assert res.status_code == 404 and "switched off" in res.json()["error"]["message"]
    new_token = client.post(f"/api/projects/{p['id']}/share").json()["share"]["token"]
    assert new_token != token and client.get(f"/api/share/{new_token}").status_code == 200


@pytest.mark.parametrize("bad", ["x", "..%2Fprojects", "a" * 65, "abc$def" * 4, "%2e%2e%2fprojects"])
def test_malformed_share_tokens_are_404(client, bad):
    assert client.get(f"/api/share/{bad}").status_code == 404


def test_damaged_share_snapshot_is_a_clean_error(client, stores):
    p, _ = project_with_saved_plan(client)
    token = client.post(f"/api/projects/{p['id']}/share").json()["share"]["token"]
    path = stores[1]._shares / f"{token}.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["plan"]["walls"][0]["start"] = ["x", 1]
    path.write_text(json.dumps(data), encoding="utf-8")
    res = client.get(f"/api/share/{token}")
    assert res.status_code == 422 and res.json()["error"]["code"] == "invalid_structure"
    assert client.get(f"/api/projects/{p['id']}").json()["share"]["up_to_date"] is False


def test_uncalibrated_plan_can_be_shared_and_says_so(client):
    p, _ = project_with_saved_plan(client, calibrated=False)
    token = client.post(f"/api/projects/{p['id']}/share").json()["share"]["token"]
    assert client.get(f"/api/share/{token}").json()["plan"]["scale"]["calibrated"] is False
