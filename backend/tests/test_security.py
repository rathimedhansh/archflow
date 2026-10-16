"""Deployment stage 1: developer sign-in, CSRF, request limits and processing-slot caps (API level)."""

import io
import secrets

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import SecretStr

from app.api.floorplans import get_store
from app.api.projects import get_project_store
from app.config import settings
from app.main import app
from app.security import sessions
from app.security.limits import interpretation_slots, limiter, upload_slots
from app.security.middleware import is_public
from app.security.passwords import hash_password
from app.storage.floorplans import FloorPlanStore
from app.storage.projects import ProjectStore

PASSWORD = secrets.token_urlsafe(18)  # random per run; never printed
PASSWORD_HASH = hash_password(PASSWORD)
CSRF = {"X-ARCHFLOW-CSRF": "1"}
ID = "0" * 32


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def clock(monkeypatch):
    c = FakeClock()
    monkeypatch.setattr(limiter, "clock", c)
    return c


@pytest.fixture
def stores(tmp_path):
    plans, projects = FloorPlanStore(tmp_path), ProjectStore(tmp_path)
    app.dependency_overrides[get_store] = lambda: plans
    app.dependency_overrides[get_project_store] = lambda: projects
    yield plans, projects
    app.dependency_overrides.clear()


@pytest.fixture
def secure(monkeypatch, stores, clock):
    """Sign-in on, as in production (limits stay off unless a test switches them on)."""
    monkeypatch.setattr(settings, "admin_password_hash", SecretStr(PASSWORD_HASH))
    monkeypatch.setattr(settings, "session_secret", SecretStr(secrets.token_urlsafe(48)))
    monkeypatch.setattr(settings, "rate_limits", False)
    limiter.reset()
    yield stores
    limiter.reset()


@pytest.fixture
def anon(secure):
    return TestClient(app)


@pytest.fixture
def dev(secure):
    """Signed-in developer client."""
    c = TestClient(app)
    res = c.post("/api/auth/login", json={"password": PASSWORD}, headers=CSRF)
    assert res.status_code == 200
    return c


def png(size=(400, 300)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, "white").save(buf, format="PNG")
    return buf.getvalue()


def upload(client, headers=CSRF):
    return client.post("/api/floorplans", files={"file": ("plan.png", png(), "image/png")}, headers=headers)


def plan_body(floorplan_id: str) -> dict:
    return {
        "provenance": "manual",
        "source": {"floorplan_id": floorplan_id, "width_px": 400, "height_px": 300},
        "scale": {"meters_per_pixel": 0.01, "calibrated": True},
        "walls": [{"id": "wall-1", "start": [0.5, 0.5], "end": [3.5, 0.5], "height": 2.8, "thickness": 0.2}],
        "rooms": [{"id": "room-1", "name": "Living room", "polygon": [[0.5, 0.5], [3.5, 0.5], [3.5, 2.5], [0.5, 2.5]]}],
        "doors": [], "windows": [],
    }


def published_property(dev) -> tuple[str, dict]:
    """A project with a saved plan and a published buyer link; returns (token, buyer JSON)."""
    project = dev.post("/api/projects", json={"name": "Test Villa", "address": "1 Test Road"}, headers=CSRF).json()
    fp = upload(dev).json()["id"]
    assert dev.put(f"/api/projects/{project['id']}/floorplan", json={"floorplan_id": fp}, headers=CSRF).status_code == 200
    assert dev.put(f"/api/floorplans/{fp}/structure", json=plan_body(fp), headers=CSRF).status_code == 200
    token = dev.post(f"/api/projects/{project['id']}/share", headers=CSRF).json()["share"]["token"]
    return token, dev.get(f"/api/share/{token}").json()


# ---- unauthorised requests ------------------------------------------------------------------------

def _concrete(path: str) -> str:
    return path.replace("{plan_id}", ID).replace("{project_id}", ID).replace("{token}", "t" * 24)


# Every route the app serves, from its own OpenAPI description (this FastAPI version nests included routers).
API_ROUTES = sorted(
    (method.upper(), _concrete(path))
    for path, ops in app.openapi()["paths"].items() if path.startswith("/api/")
    for method in ops
)
PROTECTED = [(m, p) for m, p in API_ROUTES if not is_public(m, p)]


def test_route_inventory_is_what_we_expect():
    # Guard against the inventory below silently becoming empty or missing the developer routes.
    fp, pr = f"/api/floorplans/{ID}", f"/api/projects/{ID}"
    assert set(PROTECTED) == {
        ("GET", "/api/projects"), ("POST", "/api/projects"),
        ("GET", pr), ("PATCH", pr), ("DELETE", pr), ("PUT", f"{pr}/floorplan"),
        ("POST", f"{pr}/share"), ("DELETE", f"{pr}/share"),
        ("POST", "/api/floorplans"), ("GET", fp), ("GET", f"{fp}/image"),
        ("GET", f"{fp}/structure"), ("PUT", f"{fp}/structure"),
        ("POST", f"{fp}/interpret"), ("GET", f"{fp}/interpretation"),
    }
    assert {p for _, p in API_ROUTES if is_public("GET", p) or is_public("POST", p)} == {
        "/api/health", "/api/auth/me", "/api/auth/login", "/api/auth/logout", f"/api/share/{'t' * 24}"}


@pytest.mark.parametrize(("method", "path"), PROTECTED)
def test_every_developer_route_needs_a_session(anon, method, path):
    res = anon.request(method, path, headers=CSRF, json={})
    assert res.status_code == 401, (method, path)
    assert res.json()["error"]["code"] == "unauthorized"


def test_unauthorised_requests_change_nothing(anon, secure):
    plans, projects = secure
    assert anon.post("/api/projects", json={"name": "X"}, headers=CSRF).status_code == 401
    assert upload(anon).status_code == 401
    assert projects.list() == [] and not any(plans._root.iterdir())


def test_project_list_with_buyer_tokens_is_not_public(dev, anon):
    published_property(dev)
    res = anon.get("/api/projects")
    assert res.status_code == 401 and "share" not in res.text


def test_bad_sessions_are_refused(anon, monkeypatch):
    good = sessions.issue(settings)
    payload, _, sig = good.partition(".")
    forged = payload[:-2] + ("AA" if payload[-2:] != "AA" else "BB") + "." + sig
    expired = sessions.issue(settings, now=1_000)
    for cookie in ("", "garbage", forged, payload + ".", expired, good + "x"):
        anon.cookies.set(sessions.COOKIE_NAME, cookie)
        assert anon.get("/api/projects").status_code == 401, cookie[:12]
    anon.cookies.set(sessions.COOKIE_NAME, good)
    assert anon.get("/api/projects").status_code == 200
    # Changing the secret or the password hash ends every session.
    monkeypatch.setattr(settings, "session_secret", SecretStr(secrets.token_urlsafe(48)))
    assert anon.get("/api/projects").status_code == 401
    anon.cookies.set(sessions.COOKIE_NAME, sessions.issue(settings))
    assert anon.get("/api/projects").status_code == 200
    monkeypatch.setattr(settings, "admin_password_hash", SecretStr(hash_password("another password")))
    assert anon.get("/api/projects").status_code == 401


# ---- public buyer links ---------------------------------------------------------------------------

def test_buyer_link_works_without_signing_in(dev, anon):
    token, as_seen_by_developer = published_property(dev)
    res = anon.get(f"/api/share/{token}")
    assert res.status_code == 200 and "set-cookie" not in res.headers
    body = res.json()
    assert body == as_seen_by_developer
    assert set(body) == {"property", "plan", "published_at"}
    assert body["property"] == {"name": "Test Villa", "address": "1 Test Road", "description": ""}
    assert body["plan"]["source"]["floorplan_id"] == "shared"
    assert anon.get("/api/share/" + "u" * 24).status_code == 404  # unknown link: 404, not a sign-in prompt
    assert anon.head(f"/api/share/{token}").status_code in (200, 405)  # never 401


def test_switched_off_buyer_link_is_gone_for_everyone(dev, anon):
    token, _ = published_property(dev)
    project = dev.get("/api/projects").json()[0]
    assert dev.delete(f"/api/projects/{project['id']}/share", headers=CSRF).status_code == 200
    assert anon.get(f"/api/share/{token}").status_code == 404


def test_health_stays_public(anon):
    res = anon.get("/api/health")
    assert res.status_code == 200 and res.json()["status"] == "ok"


# ---- sign-in --------------------------------------------------------------------------------------

def test_wrong_password_is_refused_without_a_cookie(anon):
    res = anon.post("/api/auth/login", json={"password": "not the password"}, headers=CSRF)
    assert res.status_code == 401 and res.json()["error"]["code"] == "invalid_credentials"
    assert "set-cookie" not in res.headers
    assert anon.get("/api/projects").status_code == 401


def test_login_sets_a_hardened_cookie_and_unlocks_the_api(anon, monkeypatch):
    res = anon.post("/api/auth/login", json={"password": PASSWORD}, headers=CSRF)
    assert res.status_code == 200 and res.json() == {"auth_enabled": True, "authenticated": True}
    cookie = res.headers["set-cookie"]
    for part in ("archflow_session=", "HttpOnly", "SameSite=Lax", "Path=/", f"Max-Age={12 * 3600}"):
        assert part in cookie
    assert "Secure" not in cookie  # development default
    assert PASSWORD not in cookie and PASSWORD not in res.text
    assert anon.get("/api/projects").status_code == 200
    assert anon.get("/api/auth/me").json() == {"auth_enabled": True, "authenticated": True}

    monkeypatch.setattr(settings, "cookie_secure", True)
    assert "; Secure" in anon.post("/api/auth/login", json={"password": PASSWORD}, headers=CSRF).headers["set-cookie"]


def test_signed_in_developer_can_do_the_whole_flow(dev):
    token, buyer = published_property(dev)
    fp = dev.get("/api/projects").json()[0]["floorplan"]["id"]
    assert dev.get(f"/api/floorplans/{fp}/image").status_code == 200
    assert dev.get(f"/api/floorplans/{fp}/structure").json()["rooms"][0]["name"] == "Living room"
    assert buyer["property"]["name"] == "Test Villa"


def test_logout_ends_the_session_in_this_browser(dev):
    res = dev.post("/api/auth/logout", headers=CSRF)
    assert res.status_code == 204 and "Max-Age=0" in res.headers["set-cookie"]
    assert dev.get("/api/projects").status_code == 401
    assert dev.get("/api/auth/me").json() == {"auth_enabled": True, "authenticated": False}


def test_session_is_renewed_after_half_its_lifetime(anon):
    old = sessions.issue(settings, now=__import__("time").time() - 7 * 3600)  # 7 h of 12 h used
    anon.cookies.set(sessions.COOKIE_NAME, old)
    res = anon.get("/api/projects")
    assert res.status_code == 200 and "archflow_session=" in res.headers.get("set-cookie", "")
    fresh = anon.get("/api/projects")  # the client stored the renewed cookie
    assert fresh.status_code == 200 and "set-cookie" not in fresh.headers


def test_sign_in_off_in_development_keeps_everything_open(stores, monkeypatch):
    monkeypatch.setattr(settings, "admin_password_hash", SecretStr(""))
    monkeypatch.setattr(settings, "env", "development")
    c = TestClient(app)
    assert c.get("/api/auth/me").json() == {"auth_enabled": False, "authenticated": False}
    assert c.get("/api/projects").status_code == 200
    assert c.post("/api/projects", json={"name": "Open"}).status_code == 201  # no CSRF header needed
    assert c.post("/api/auth/login", json={"password": "x"}).json()["error"]["code"] == "conflict"


# ---- CSRF -----------------------------------------------------------------------------------------

@pytest.mark.parametrize("headers", [{}, {"X-ARCHFLOW-CSRF": "0"}, {"X-ARCHFLOW-CSRF": "true"}, {"X-Requested-With": "1"}])
def test_writes_without_the_csrf_header_are_refused(dev, secure, headers):
    _, projects = secure
    res = dev.post("/api/projects", json={"name": "Forged"}, headers=headers)
    assert res.status_code == 403 and res.json()["error"]["code"] == "csrf_failed"
    assert projects.list() == []
    for method, path in (("PUT", f"/api/floorplans/{ID}/structure"), ("DELETE", f"/api/projects/{ID}"),
                         ("PATCH", f"/api/projects/{ID}"), ("POST", "/api/floorplans")):
        assert dev.request(method, path, headers=headers, json={}).status_code == 403
    assert dev.post("/api/projects", json={"name": "Real"}, headers=CSRF).status_code == 201


def test_login_itself_needs_the_csrf_header(anon):
    res = anon.post("/api/auth/login", json={"password": PASSWORD})
    assert res.status_code == 403 and "set-cookie" not in res.headers


def test_reads_need_no_csrf_header(dev):
    assert dev.get("/api/projects").status_code == 200


def test_other_websites_get_no_cors_permission(anon):
    pre = anon.options("/api/projects", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST",
                                                 "Access-Control-Request-Headers": "x-archflow-csrf"})
    assert "access-control-allow-origin" not in pre.headers
    ok = anon.options("/api/projects", headers={"Origin": "http://localhost:3000", "Access-Control-Request-Method": "POST",
                                                "Access-Control-Request-Headers": "x-archflow-csrf"})
    assert ok.headers["access-control-allow-origin"] == "http://localhost:3000"
    assert ok.headers["access-control-allow-credentials"] == "true"


def test_refusals_carry_cors_headers_so_the_frontend_can_read_them(anon):
    res = anon.get("/api/projects", headers={"Origin": "http://localhost:3000"})
    assert res.status_code == 401 and res.headers["access-control-allow-origin"] == "http://localhost:3000"


# ---- request limits -------------------------------------------------------------------------------

@pytest.fixture
def limits(monkeypatch, dev):
    monkeypatch.setattr(settings, "rate_limits", True)
    monkeypatch.setattr(settings, "rate_upload_per_minute", 3)
    monkeypatch.setattr(settings, "rate_upload_per_day", 5)
    monkeypatch.setattr(settings, "rate_interpret_per_minute", 2)
    monkeypatch.setattr(settings, "rate_write_per_minute", 50)
    return dev


def test_uploads_are_limited_per_minute_and_recover(limits, clock, secure):
    plans, _ = secure
    assert [upload(limits).status_code for _ in range(3)] == [201, 201, 201]
    res = upload(limits)
    assert res.status_code == 429 and res.json()["error"]["code"] == "rate_limited"
    assert 1 <= int(res.headers["retry-after"]) <= 20
    assert len(list(plans._root.iterdir())) == 3  # the refused upload stored nothing
    clock.t += int(res.headers["retry-after"])
    assert upload(limits).status_code == 201


def test_uploads_are_limited_per_day(limits, clock):
    codes = []
    for _ in range(7):
        codes.append(upload(limits).status_code)
        clock.t += 60  # stay under the per-minute limit
    assert codes == [201] * 5 + [429] * 2
    res = upload(limits)
    assert "today" in res.json()["error"]["message"] and int(res.headers["retry-after"]) > 3600


def test_detection_is_limited_per_minute(limits):
    fp = upload(limits).json()["id"]
    first = [limits.post(f"/api/floorplans/{fp}/interpret", headers=CSRF).status_code for _ in range(2)]
    assert first == [200, 200]
    res = limits.post(f"/api/floorplans/{fp}/interpret", headers=CSRF)
    assert res.status_code == 429 and "detections" in res.json()["error"]["message"]


def test_other_writes_have_a_general_limit(limits, monkeypatch):
    monkeypatch.setattr(settings, "rate_write_per_minute", 4)
    codes = [limits.post("/api/projects", json={"name": f"P{i}"}, headers=CSRF).status_code for i in range(5)]
    assert codes == [201] * 4 + [429]
    assert limits.get("/api/projects").status_code == 200  # reads are not limited


def test_login_attempts_are_limited_even_with_the_right_password(anon, monkeypatch):
    monkeypatch.setattr("app.api.auth.FAILURE_DELAY_S", 0)
    codes = [anon.post("/api/auth/login", json={"password": "wrong"}, headers=CSRF).status_code for _ in range(5)]
    assert codes == [401] * 5
    res = anon.post("/api/auth/login", json={"password": PASSWORD}, headers=CSRF)
    assert res.status_code == 429 and "set-cookie" not in res.headers


def test_forwarded_for_header_cannot_dodge_limits(limits):
    codes = [upload(limits, headers={**CSRF, "X-Forwarded-For": f"203.0.113.{i}"}).status_code for i in range(4)]
    assert codes == [201, 201, 201, 429]


def test_limits_are_on_by_default_only_in_production():
    from app.config import Settings

    assert Settings(env="production").rate_limits_enabled is True
    assert Settings(env="development").rate_limits_enabled is False
    assert Settings(env="development", rate_limits=True).rate_limits_enabled is True
    assert Settings(env="production").cookie_secure_enabled is True


# ---- processing-slot caps -------------------------------------------------------------------------

def test_a_second_detection_at_the_same_time_gets_busy(dev):
    fp = upload(dev).json()["id"]
    held = interpretation_slots.try_acquire(1)
    assert held is not None
    try:
        res = dev.post(f"/api/floorplans/{fp}/interpret", headers=CSRF)
        assert res.status_code == 503 and res.json()["error"]["code"] == "busy"
        assert int(res.headers["retry-after"]) > 0
    finally:
        held.release()
    res = dev.post(f"/api/floorplans/{fp}/interpret", headers=CSRF)
    assert res.status_code == 200 and '"type": "result"' in res.text
    assert interpretation_slots.in_use == 0  # freed after a completed run


def test_detection_slot_is_freed_after_a_failure(dev, secure, monkeypatch):
    plans, _ = secure
    fp = upload(dev).json()["id"]

    def disk_full(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(plans, "save_interpretation", disk_full)
    res = dev.post(f"/api/floorplans/{fp}/interpret", headers=CSRF)
    assert '"type": "error"' in res.text and interpretation_slots.in_use == 0


def test_unknown_plan_does_not_take_a_detection_slot(dev):
    assert dev.post(f"/api/floorplans/{ID}/interpret", headers=CSRF).status_code == 404
    assert interpretation_slots.in_use == 0


def test_uploads_beyond_the_concurrency_cap_get_busy(dev, secure):
    plans, _ = secure
    held = [upload_slots.try_acquire(2), upload_slots.try_acquire(2)]
    try:
        res = upload(dev)
        assert res.status_code == 503 and res.json()["error"]["code"] == "busy"
        assert not any(plans._root.iterdir())
    finally:
        for h in held:
            h.release()
    assert upload(dev).status_code == 201 and upload_slots.in_use == 0


def test_invalid_upload_frees_its_slot(dev):
    res = dev.post("/api/floorplans", files={"file": ("x.png", b"not an image", "image/png")}, headers=CSRF)
    assert res.status_code == 422 and upload_slots.in_use == 0
