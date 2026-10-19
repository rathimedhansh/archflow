"""Stage 3: the 20-megapixel image limit, malformed and bomb-style images, and detection on oversized plans.

All files are built in memory; stores live in pytest's tmp_path.
"""

import io
import json
import struct
import zlib

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageFile, PngImagePlugin
from pydantic import ValidationError

from app.api.floorplans import get_store
from app.config import MAX_IMAGE_PIXELS_CEILING, Settings, settings
from app.errors import InvalidImage, UnsupportedFileType
from app.interpretation.opencv.preprocess import load_image
from app.interpretation.opencv.types import Unsupported
from app.main import app
from app.processing.image_intake import normalize_upload
from app.security.limits import interpretation_slots, limiter, upload_slots
from app.storage.floorplans import FloorPlanStore


# ---- builders -----------------------------------------------------------------------------------------

def encode(img: Image.Image, fmt="PNG", **kw) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format=fmt, **kw)
    return buf.getvalue()


def blank(w, h, mode="1", fmt="PNG", **kw) -> bytes:
    return encode(Image.new(mode, (w, h), 1 if mode == "1" else "white"), fmt, **kw)


def chunk(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)


def crafted_png(w, h, *, idat: bytes | None = None, bad_ihdr_crc=False, extra=b"") -> bytes:
    """A PNG whose header declares w x h, with whatever image data we choose (none decoded in these tests)."""
    ihdr = chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 1, 0, 0, 0, 0))  # 1-bit greyscale
    if bad_ihdr_crc:
        ihdr = ihdr[:-4] + b"\0\0\0\0"
    data = idat if idat is not None else zlib.compress(b"\0" * 64)
    return b"\x89PNG\r\n\x1a\n" + ihdr + extra + chunk(b"IDAT", data) + chunk(b"IEND", b"")


def with_chunk_before_idat(png: bytes, extra: bytes) -> bytes:
    i = png.index(b"IDAT") - 4
    return png[:i] + extra + png[i:]


BOMB = zlib.compress(b"\0" * (64 * 2**20), 9)  # 64 MiB of zeros in ~64 KB


@pytest.fixture
def store(tmp_path):
    s = FloorPlanStore(tmp_path)
    app.dependency_overrides[get_store] = lambda: s
    yield s
    app.dependency_overrides.clear()


@pytest.fixture
def client(store):
    return TestClient(app)


def upload(client, data: bytes, name="plan.png"):
    return client.post("/api/floorplans", files={"file": (name, data, "application/octet-stream")})


def assert_too_large(res, *fragments):
    assert res.status_code == 422, res.text
    err = res.json()["error"]
    assert err["code"] == "invalid_image" and "too large" in err["message"]
    assert "The limit is 20,000,000 pixels (20 megapixels)" in err["message"]
    for f in fragments:
        assert f in err["message"]


def assert_invalid(res):
    assert res.status_code == 422, res.text
    assert res.json()["error"] == {"code": "invalid_image", "message": "File is not a valid PNG or JPEG image."}


# ---- the limit and its setting --------------------------------------------------------------------------

def test_default_limit_is_the_20_megapixel_ceiling_and_pillow_follows_it():
    assert MAX_IMAGE_PIXELS_CEILING == 20_000_000 and settings.max_image_pixels == 20_000_000
    assert Image.MAX_IMAGE_PIXELS == settings.max_image_pixels  # Pillow's own guard is not looser than ours


@pytest.mark.parametrize("value", [0, -1, 20_000_001, 40_000_000])
def test_setting_can_only_lower_the_limit(value):
    with pytest.raises(ValidationError) as err:
        Settings(max_image_pixels=value)
    assert "max_image_pixels" in str(err.value)
    assert Settings(max_image_pixels=1_000_000).max_image_pixels == 1_000_000


def test_setting_from_the_environment_is_bounded_too(monkeypatch):
    monkeypatch.setenv("ARCHFLOW_MAX_IMAGE_PIXELS", "25000000")
    with pytest.raises(ValidationError):
        Settings()
    monkeypatch.setenv("ARCHFLOW_MAX_IMAGE_PIXELS", "8000000")
    assert Settings().max_image_pixels == 8_000_000


def test_a_lower_limit_is_enforced(monkeypatch):
    monkeypatch.setattr(settings, "max_image_pixels", 1_000_000)
    assert normalize_upload(blank(1000, 1000)).width == 1000
    with pytest.raises(InvalidImage) as err:
        normalize_upload(blank(1001, 1000))
    assert "1001 × 1000 px = 1,001,000 pixels" in err.value.message
    assert "limit is 1,000,000 pixels (1 megapixel)" in err.value.message


# ---- exact boundaries -----------------------------------------------------------------------------------

@pytest.mark.parametrize(("w", "h"), [(5000, 4000), (4000, 5000), (3, 6_666_666)])
def test_exactly_at_or_just_under_the_limit_is_accepted(client, w, h):
    assert w * h <= 20_000_000
    res = upload(client, blank(w, h))
    assert res.status_code == 201, res.text
    assert (res.json()["width"], res.json()["height"]) == (w, h)


@pytest.mark.parametrize(("w", "h"), [(3, 6_666_667), (6_666_667, 3), (5000, 4001), (4473, 4472)])
def test_one_step_over_the_limit_is_refused(client, store, w, h):
    assert w * h > 20_000_000
    res = upload(client, blank(w, h))
    assert_too_large(res, f"{w} × {h} px")
    assert not any(store._root.iterdir()) and upload_slots.in_use == 0


@pytest.mark.parametrize(("w", "h", "exact"), [
    (3, 6_666_667, "20,000,001"),   # one pixel over
    (4472, 4473, "20,003,256"),     # one row over; used to read "20.0 megapixels"
    (5000, 4001, "20,005,000"),
])
def test_size_just_over_the_limit_is_never_shown_as_the_limit(client, w, h, exact):
    msg = upload(client, blank(w, h)).json()["error"]["message"]
    assert f"({w} × {h} px = {exact} pixels)" in msg
    assert "The limit is 20,000,000 pixels (20 megapixels)" in msg
    assert "20.0 megapixels" not in msg and exact != "20,000,000"


def test_detection_loader_message_is_exact_too(tmp_path):
    f = tmp_path / "over.png"
    f.write_bytes(crafted_png(4472, 4473))
    with pytest.raises(Unsupported) as err:
        load_image(f)
    msg = str(err.value)
    assert "4472 × 4473 px = 20,003,256 pixels" in msg and "the limit is 20,000,000 pixels (20 megapixels)" in msg


def test_jpeg_boundaries_too(client):
    assert upload(client, blank(5000, 4000, "L", "JPEG"), "a.jpg").status_code == 201
    assert_too_large(upload(client, blank(5000, 4001, "L", "JPEG"), "b.jpg"), "5000 × 4001 px")


# ---- oversized images are refused before verify() and before decoding ----------------------------------

@pytest.fixture
def decode_spy(monkeypatch):
    calls = {"load": 0, "verify": 0}
    real_load, real_verify = ImageFile.ImageFile.load, PngImagePlugin.PngImageFile.verify

    def load(self, *a, **k):
        calls["load"] += 1
        return real_load(self, *a, **k)

    def verify(self, *a, **k):
        calls["verify"] += 1
        return real_verify(self, *a, **k)

    monkeypatch.setattr(ImageFile.ImageFile, "load", load)
    monkeypatch.setattr(PngImagePlugin.PngImageFile, "verify", verify)
    return calls


@pytest.mark.parametrize(("w", "h"), [(6000, 6000), (5000, 4001)])  # between 1x and 2x Pillow's guard (20-40 MP)
def test_oversized_header_is_refused_without_verify_or_decode(decode_spy, w, h):
    data = crafted_png(w, h)  # a few hundred bytes; the image data would not even decode
    with pytest.raises(InvalidImage) as err:
        normalize_upload(data)
    assert f"{w} × {h} px" in err.value.message and decode_spy == {"load": 0, "verify": 0}


def test_far_oversized_header_is_refused_by_pillows_guard_with_the_same_answer(client, decode_spy):
    res = upload(client, crafted_png(100_000, 100_000))  # 10,000 MP declared in a tiny file
    assert_too_large(res, "(10,000,000,000 pixels)")
    assert decode_spy == {"load": 0, "verify": 0}


def test_previous_hole_45_megapixels_in_a_tiny_file_is_closed(client, decode_spy):
    """Accepted and fully decoded before Stage 3 (Pillow only warned between 40 and 80 MP)."""
    data = blank(7000, 6500)
    assert len(data) < 20_000
    # Over twice the 20 MP guard, so Pillow itself refuses it while opening: the answer gives the pixel count.
    assert_too_large(upload(client, data), "(45,500,000 pixels)")
    assert decode_spy == {"load": 0, "verify": 0}


# ---- malformed and bomb-style files: always a clean 422/415, never 500 -----------------------------------

@pytest.mark.parametrize("kind,payload", [
    (b"zTXt", b"comment\0\0" + BOMB),
    (b"iTXt", b"comment\0\1\0\0\0" + BOMB),
    (b"iCCP", b"profile\0\0" + BOMB),
], ids=["zTXt", "iTXt", "iCCP"])
def test_metadata_decompression_bombs_are_a_clean_422(client, store, kind, payload):
    data = with_chunk_before_idat(blank(64, 64, "L"), chunk(kind, payload))
    assert len(data) < 200_000
    res = upload(client, data)
    assert_invalid(res)
    assert not any(store._root.iterdir()) and upload_slots.in_use == 0


def test_too_much_text_overall_is_a_clean_422():
    extra = b"".join(chunk(b"tEXt", b"k%d\0" % i + b"x" * 1_000_000) for i in range(70))  # > 64 MB of text
    with pytest.raises(InvalidImage):
        normalize_upload(with_chunk_before_idat(blank(16, 16, "L"), extra))


def test_small_harmless_metadata_is_accepted_and_dropped():
    data = with_chunk_before_idat(blank(64, 64, "L"), chunk(b"tEXt", b"Author\0someone"))
    out = normalize_upload(data)
    assert b"tEXt" not in out.png_bytes and b"Author" not in out.png_bytes


@pytest.mark.parametrize("name,data", [
    ("bad IHDR checksum", crafted_png(64, 64, bad_ihdr_crc=True)),
    ("garbage image data", crafted_png(64, 64, idat=b"not zlib at all" * 10)),
    ("image data too short", crafted_png(640, 480, idat=zlib.compress(b"\0" * 10))),
    ("zero width", crafted_png(0, 64)),
    ("truncated PNG", blank(300, 200, "L")[:-40]),
    ("truncated JPEG", blank(300, 200, "L", "JPEG")[:200]),
    ("PNG signature only", b"\x89PNG\r\n\x1a\n"),
    ("random bytes", bytes(np.random.default_rng(3).integers(0, 256, 4096, dtype=np.uint8))),
    ("text", b"hello, this is not an image"),
], ids=lambda v: v if isinstance(v, str) else "")
def test_malformed_files_are_a_clean_422(client, store, name, data):
    assert_invalid(upload(client, data))
    assert not any(store._root.iterdir()) and upload_slots.in_use == 0


@pytest.mark.parametrize("fmt", ["GIF", "WEBP", "BMP", "TIFF"])
def test_other_formats_are_still_415_whatever_the_name(client, fmt):
    res = upload(client, blank(64, 64, "RGB", fmt), name="looks-like.png")
    assert res.status_code == 415 and res.json()["error"]["code"] == "unsupported_file_type"


def test_decoded_size_must_match_the_header(monkeypatch):
    real_load = ImageFile.ImageFile.load

    def lying_decoder(self, *a, **k):
        out = real_load(self, *a, **k)
        # A stable lie (the same on every call), so nothing downstream breaks by accident: only the recheck can
        # notice that the decoded size differs from the header's.
        self._size = (self.im.size[0] + 7, self.im.size[1])
        return out

    monkeypatch.setattr(ImageFile.ImageFile, "load", lying_decoder)
    with pytest.raises(InvalidImage) as err:
        normalize_upload(blank(100, 100, "L"))
    assert err.value.message == "File is not a valid PNG or JPEG image."


def test_truncated_images_stay_refused():
    assert ImageFile.LOAD_TRUNCATED_IMAGES is False
    with pytest.raises(InvalidImage):
        normalize_upload(blank(300, 200, "RGB", "JPEG")[:-100])


def test_format_comes_from_content_not_name(client):
    res = upload(client, blank(64, 48, "RGB", "JPEG"), name="drawing.png")
    assert res.status_code == 201 and res.json()["source_format"] == "JPEG"
    with pytest.raises(UnsupportedFileType):
        normalize_upload(blank(8, 8, "RGB", "GIF"))


# ---- valid images keep their behaviour --------------------------------------------------------------------

@pytest.mark.parametrize("make", [
    lambda: blank(5000, 4000, "RGBA"),
    lambda: encode(Image.fromarray(np.full((4000, 5000), 40000, np.uint16), "I;16")),
    lambda: blank(5000, 4000, "CMYK", "JPEG"),
    lambda: blank(5000, 4000, "P"),
])
def test_20_megapixel_images_in_every_colour_mode_are_accepted(make):
    out = normalize_upload(make())
    assert (out.width, out.height) == (5000, 4000)
    with Image.open(io.BytesIO(out.png_bytes)) as stored:
        assert stored.format == "PNG" and stored.mode == "RGB" and stored.size == (5000, 4000)


def test_rotation_is_honoured_at_the_boundary():
    img = Image.new("RGB", (5000, 4000), "white")
    exif = img.getexif()
    exif[0x0112] = 6  # rotate 90° when displayed
    out = normalize_upload(encode(img, "JPEG", exif=exif))
    assert (out.width, out.height) == (4000, 5000)


def test_alpha_and_metadata_are_still_removed():
    img = Image.new("RGBA", (40, 30), (255, 0, 0, 0))
    info = PngImagePlugin.PngInfo()
    info.add_text("Secret", "should not survive")
    out = normalize_upload(encode(img, pnginfo=info))
    with Image.open(io.BytesIO(out.png_bytes)) as stored:
        assert stored.mode == "RGB" and "Secret" not in stored.info and b"should not survive" not in out.png_bytes


def test_file_size_limit_is_unchanged(client, monkeypatch):
    monkeypatch.setattr(settings, "max_upload_mb", 1)
    res = upload(client, b"\x89PNG" + b"\0" * (1024 * 1024 + 10))
    assert res.status_code == 413 and res.json()["error"]["code"] == "file_too_large"


# ---- detection: oversized stored plans, loader checks, extreme aspect ratios ------------------------------

def stored_plan(store, width, height) -> str:
    """A plan record claiming the given size (as an upload from before the limit would have)."""
    return store.create(png_bytes=blank(40, 30, "L"), original_filename="old.png", source_format="PNG",
                        width=width, height=height).id


class Clock:
    t = 1000.0

    def __call__(self):
        return self.t


def test_oversized_stored_plan_is_refused_before_slot_and_detection_budget(client, store, monkeypatch):
    monkeypatch.setattr(limiter, "clock", Clock())
    limiter.reset()
    monkeypatch.setattr(settings, "rate_limits", True)
    monkeypatch.setattr(settings, "rate_interpret_per_minute", 1)
    big = stored_plan(store, 6000, 5000)
    for _ in range(3):
        res = client.post(f"/api/floorplans/{big}/interpret")
        assert_too_large(res, "6000 × 5000 px = 30,000,000 pixels")
        assert interpretation_slots.in_use == 0
    assert client.post(f"/api/floorplans/{'0' * 32}/interpret").status_code == 404  # unknown: no budget either
    normal = upload(client, blank(400, 300, "L")).json()["id"]
    first = client.post(f"/api/floorplans/{normal}/interpret")
    assert first.status_code == 200 and '"type": "result"' in first.text  # the one allowed detection is still there
    second = client.post(f"/api/floorplans/{normal}/interpret")
    assert second.status_code == 429 and "detections" in second.json()["error"]["message"]
    limiter.reset()


def test_detection_limit_still_applies_only_when_limits_are_on(client, store, monkeypatch):
    monkeypatch.setattr(settings, "rate_limits", False)
    monkeypatch.setattr(settings, "rate_interpret_per_minute", 1)
    plan = upload(client, blank(400, 300, "L")).json()["id"]
    assert [client.post(f"/api/floorplans/{plan}/interpret").status_code for _ in range(3)] == [200, 200, 200]


def test_loader_refuses_oversized_files_before_decoding(tmp_path, monkeypatch):
    decoded = []
    real = __import__("cv2").imdecode
    monkeypatch.setattr("app.interpretation.opencv.preprocess.cv2.imdecode", lambda *a: decoded.append(1) or real(*a))
    over = tmp_path / "over.png"
    over.write_bytes(crafted_png(5000, 4001))
    with pytest.raises(Unsupported, match="too large for automatic detection"):
        load_image(over)
    bomb = tmp_path / "bomb.png"
    bomb.write_bytes(crafted_png(100_000, 100_000))
    with pytest.raises(Unsupported, match="too large for automatic detection"):
        load_image(bomb)
    assert decoded == []
    ok = tmp_path / "ok.png"
    ok.write_bytes(blank(400, 300, "L"))
    assert load_image(ok).shape == (300, 400) and decoded == [1]


def test_loader_checks_the_decoded_size_too(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "max_image_pixels", 100)
    f = tmp_path / "x.png"
    f.write_bytes(blank(20, 20, "L"))
    monkeypatch.setattr("app.interpretation.opencv.preprocess.Image.open", lambda *a: (_ for _ in ()).throw(OSError("no header")))
    with pytest.raises(Unsupported, match="too large"):
        load_image(f)


@pytest.mark.parametrize(("w", "h"), [(3, 6_666_666), (6_666_666, 3), (20_000, 1_000), (1, 2), (2000, 1)])
def test_extreme_aspect_ratios_get_a_controlled_detection_result(client, w, h):
    up = upload(client, blank(w, h))
    assert up.status_code == 201, up.text
    res = client.post(f"/api/floorplans/{up.json()['id']}/interpret")
    assert res.status_code == 200
    lines = [json.loads(line) for line in res.text.splitlines() if line.strip()]
    assert lines[-1]["type"] == "result", lines[-1]  # explained result, not an error line or a 500
    assert interpretation_slots.in_use == 0
