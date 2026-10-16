import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.api.floorplans import get_store
from app.config import settings
from app.main import app
from app.storage.floorplans import FloorPlanStore


@pytest.fixture
def client(tmp_path):
    store = FloorPlanStore(tmp_path)
    app.dependency_overrides[get_store] = lambda: store
    yield TestClient(app)
    app.dependency_overrides.clear()


def make_image(fmt="PNG", size=(400, 300), mode="RGB") -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, "white").save(buf, format=fmt)
    return buf.getvalue()


def upload(client, data: bytes, name="plan.png", mime="image/png"):
    return client.post("/api/floorplans", files={"file": (name, data, mime)})


def test_upload_png_roundtrip(client):
    res = upload(client, make_image("PNG"))
    assert res.status_code == 201
    body = res.json()
    assert (body["width"], body["height"]) == (400, 300)
    assert body["source_format"] == "PNG"
    assert body["status"] == "ready"

    meta = client.get(f"/api/floorplans/{body['id']}")
    assert meta.status_code == 200 and meta.json()["id"] == body["id"]

    img = client.get(body["image_url"])
    assert img.status_code == 200
    assert img.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(img.content)).size == (400, 300)


def test_upload_jpeg_is_normalized_to_png(client):
    res = upload(client, make_image("JPEG"), "plan.jpg", "image/jpeg")
    assert res.status_code == 201
    assert res.json()["source_format"] == "JPEG"
    img = client.get(res.json()["image_url"])
    assert Image.open(io.BytesIO(img.content)).format == "PNG"


def test_rgba_png_is_flattened(client):
    res = upload(client, make_image("PNG", mode="RGBA"))
    assert res.status_code == 201


def test_content_not_extension_decides_type(client):
    # A GIF renamed to .png must be rejected.
    res = upload(client, make_image("GIF"), "plan.png", "image/png")
    assert res.status_code == 415
    assert res.json()["error"]["code"] == "unsupported_file_type"


def test_non_image_rejected(client):
    res = upload(client, b"%PDF-1.4 not an image", "plan.png", "image/png")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "invalid_image"


def test_empty_file_rejected(client):
    res = upload(client, b"")
    assert res.status_code == 422


def test_truncated_image_rejected(client):
    res = upload(client, make_image("PNG")[:60])
    assert res.status_code == 422


@pytest.mark.parametrize("size", [(50, 50), (1, 1), (199, 800), (800, 120)])
def test_small_images_accepted(client, size):
    # There is no minimum size: small images are accepted and normalized like any other.
    res = upload(client, make_image("PNG", size=size))
    assert res.status_code == 201
    assert (res.json()["width"], res.json()["height"]) == size
    img = client.get(res.json()["image_url"])
    assert Image.open(io.BytesIO(img.content)).size == size


def test_too_large_file_rejected(client, monkeypatch):
    monkeypatch.setattr(settings, "max_upload_mb", 1)
    res = upload(client, b"\x89PNG" + b"0" * (1024 * 1024 + 10))
    assert res.status_code == 413
    assert res.json()["error"]["code"] == "file_too_large"


def test_unknown_and_malicious_ids_404(client):
    assert client.get("/api/floorplans/" + "0" * 32).status_code == 404
    assert client.get("/api/floorplans/..%2F..%2Fetc").status_code == 404
    assert client.get("/api/floorplans/not-a-valid-id/image").status_code == 404


def test_filename_never_used_as_path(client, tmp_path):
    res = upload(client, make_image("PNG"), "../../evil.png")
    assert res.status_code == 201
    assert res.json()["original_filename"] == "evil.png"
    assert not (tmp_path.parent / "evil.png").exists()
