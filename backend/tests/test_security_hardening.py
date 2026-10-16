"""Stage 1 review fixes: login concurrency and non-blocking delay, overall login limit,
development servers answer loopback only, production refuses disabled protections."""

import asyncio
import secrets
import time

import anyio.to_thread
import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.api.floorplans import get_store
from app.api.projects import get_project_store
from app.config import Settings, settings
from app.main import app
from app.security.checks import problems
from app.security.limits import limiter, login_slots
from app.security.middleware import is_loopback
from app.security.passwords import hash_password
from app.storage.floorplans import FloorPlanStore
from app.storage.projects import ProjectStore

PASSWORD = secrets.token_urlsafe(18)  # random per run; never printed
PASSWORD_HASH = hash_password(PASSWORD)
CSRF = {"X-ARCHFLOW-CSRF": "1"}


class FakeClock:
    def __init__(self):
        self.t = 5000.0

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
    monkeypatch.setattr(settings, "admin_password_hash", SecretStr(PASSWORD_HASH))
    monkeypatch.setattr(settings, "session_secret", SecretStr(secrets.token_urlsafe(48)))
    monkeypatch.setattr(settings, "rate_limits", False)
    monkeypatch.setattr("app.api.auth.FAILURE_DELAY_S", 0)
    limiter.reset()
    yield stores
    limiter.reset()


def login(client, password=PASSWORD):
    return client.post("/api/auth/login", json={"password": password}, headers=CSRF)


def from_ip(ip: str) -> TestClient:
    return TestClient(app, client=(ip, 40000))


# ---- 1. password checks: capped, refused promptly ---------------------------------------------------

def test_excess_password_checks_are_refused_at_once_without_hashing(secure, monkeypatch):
    calls = []
    real = __import__("app.api.auth", fromlist=["verify_password"]).verify_password
    monkeypatch.setattr("app.api.auth.verify_password", lambda *a: calls.append(1) or real(*a))
    held = [login_slots.try_acquire(2), login_slots.try_acquire(2)]
    try:
        start = time.perf_counter()
        res = login(from_ip("127.0.0.1"))
        elapsed = time.perf_counter() - start
        assert res.status_code == 503 and res.json()["error"]["code"] == "busy"
        assert int(res.headers["retry-after"]) >= 1 and "set-cookie" not in res.headers
        assert elapsed < 0.25 and calls == []  # refused before any scrypt work
    finally:
        for h in held:
            h.release()
    assert login(from_ip("127.0.0.1")).status_code == 200 and calls == [1]


def test_password_check_slot_is_freed_after_every_outcome(secure):
    c = from_ip("127.0.0.1")
    assert login(c, "wrong password").status_code == 401 and login_slots.in_use == 0
    assert login(c).status_code == 200 and login_slots.in_use == 0
    assert c.post("/api/auth/login", json={"password": ""}, headers=CSRF).status_code == 422 and login_slots.in_use == 0


def test_cap_is_configurable(secure, monkeypatch):
    monkeypatch.setattr(settings, "max_concurrent_logins", 1)
    held = login_slots.try_acquire(1)
    try:
        assert login(from_ip("127.0.0.1")).status_code == 503
    finally:
        held.release()


# ---- 2. the failure delay holds no worker thread; overall login limit ---------------------------------

def _async_client(ip: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=(ip, 40000)), base_url="http://test")


def test_failure_delay_holds_no_worker_thread_and_no_slot(secure, monkeypatch):
    monkeypatch.setattr("app.api.auth.FAILURE_DELAY_S", 1.0)

    async def scenario():
        async with _async_client("127.0.0.1") as c:
            task = asyncio.create_task(c.post("/api/auth/login", json={"password": "wrong"}, headers=CSRF))
            await asyncio.sleep(0.6)  # hashing (~0.1-0.3 s) is over; the 1 s delay is running
            borrowed = anyio.to_thread.current_default_thread_limiter().borrowed_tokens
            in_use = login_slots.in_use
            res = await task
            return res.status_code, borrowed, in_use

    status, borrowed, in_use = asyncio.run(scenario())
    assert status == 401
    assert borrowed == 0, "a worker thread was held during the failure delay"
    assert in_use == 0, "the password-check slot was held during the failure delay"


def test_failed_logins_do_not_stall_other_requests(secure, monkeypatch):
    monkeypatch.setattr("app.api.auth.FAILURE_DELAY_S", 0.8)
    monkeypatch.setattr(settings, "max_concurrent_logins", 8)
    monkeypatch.setattr(settings, "rate_login_global_per_minute", 100)

    async def scenario():
        async def bad(i):
            async with _async_client(f"127.0.0.{i + 2}") as c:
                return (await c.post("/api/auth/login", json={"password": "wrong"}, headers=CSRF)).status_code

        start = time.perf_counter()
        logins = [asyncio.create_task(bad(i)) for i in range(8)]
        await asyncio.sleep(0.5)  # all eight are in their delay (or finishing their hash)
        async with _async_client("127.0.0.1") as c:
            t = time.perf_counter()
            health = await c.get("/api/health")
            health_s = time.perf_counter() - t
        codes = await asyncio.gather(*logins)
        return codes, health.status_code, health_s, time.perf_counter() - start

    codes, health_status, health_s, total = asyncio.run(scenario())
    assert codes == [401] * 8 and health_status == 200
    assert health_s < 0.3, f"health waited {health_s:.2f}s behind failed logins"
    assert total < 3.0, f"8 parallel failed logins took {total:.2f}s (delays ran one after another?)"


def test_overall_login_limit_holds_across_addresses_and_recovers(secure, clock, monkeypatch):
    monkeypatch.setattr(settings, "rate_login_global_per_minute", 3)
    monkeypatch.setattr(settings, "rate_login_per_minute", 100)
    codes = [login(from_ip(f"127.0.1.{i}"), "wrong").status_code for i in range(3)]
    assert codes == [401, 401, 401]
    res = login(from_ip("127.0.1.200"))  # a new address, even with the right password
    assert res.status_code == 429 and "on this server" in res.json()["error"]["message"]
    assert int(res.headers["retry-after"]) == 20 and "set-cookie" not in res.headers
    clock.t += 20  # one attempt every 20 s at 3 per minute
    assert login(from_ip("127.0.1.201")).status_code == 200


def test_refused_clients_do_not_use_up_the_overall_budget(secure, monkeypatch):
    monkeypatch.setattr(settings, "rate_login_global_per_minute", 5)
    monkeypatch.setattr(settings, "rate_login_per_minute", 2)
    a = [login(from_ip("127.0.2.1"), "wrong").status_code for _ in range(6)]
    assert a == [401, 401, 429, 429, 429, 429]
    b = [login(from_ip("127.0.2.2"), "wrong").status_code for _ in range(2)]
    c = login(from_ip("127.0.2.3"), "wrong").status_code
    assert b == [401, 401] and c == 401  # 2 + 2 + 1 = the 5 allowed overall
    assert login(from_ip("127.0.2.4")).status_code == 429


# ---- 3. development mode answers this computer only ------------------------------------------------------

@pytest.mark.parametrize("host", ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"])
def test_loopback_addresses_are_recognised(host):
    assert is_loopback(host)


@pytest.mark.parametrize("host", ["203.0.113.9", "192.168.1.20", "10.0.0.5", "0.0.0.0", "::", "2001:db8::1",
                                  "::ffff:192.168.1.20", "testclient", "localhost", "", None])
def test_other_addresses_are_not(host):
    assert not is_loopback(host)


@pytest.fixture
def dev_open(monkeypatch, stores):
    """Development mode with sign-in off: today's local setup."""
    monkeypatch.setattr(settings, "env", "development")
    monkeypatch.setattr(settings, "admin_password_hash", SecretStr(""))
    return stores


@pytest.mark.parametrize("host", ["203.0.113.9", "192.168.1.20", "2001:db8::1", "testclient"])
def test_development_server_refuses_other_machines_everywhere(dev_open, host):
    _, projects = dev_open
    c = from_ip(host)
    for method, path in [("GET", "/api/health"), ("GET", "/api/projects"), ("GET", "/docs"), ("GET", "/openapi.json"),
                         ("GET", f"/api/share/{'t' * 24}"), ("OPTIONS", "/api/projects")]:
        res = c.request(method, path)
        assert res.status_code == 403 and res.json()["error"]["code"] == "local_only", (host, method, path)
    assert c.post("/api/projects", json={"name": "From the network"}).status_code == 403
    assert projects.list() == []


@pytest.mark.parametrize("host", ["127.0.0.1", "::1", "::ffff:127.0.0.1"])
def test_development_server_still_serves_this_computer(dev_open, host):
    c = from_ip(host)
    assert c.get("/api/health").status_code == 200
    assert c.post("/api/projects", json={"name": "Local"}).status_code == 201  # sign-in off, as before


def test_development_with_sign_in_configured_still_refuses_the_network(secure):
    """ARCHFLOW_ENV forgotten on a server that has a password: still nothing for other machines."""
    assert not settings.is_production
    remote = from_ip("203.0.113.9")
    assert login(remote).status_code == 403
    local = from_ip("127.0.0.1")
    assert login(local).status_code == 200 and local.get("/api/projects").status_code == 200


def test_app_does_not_trust_forwarded_for_itself(dev_open):
    """Only the ASGI server may turn X-Forwarded-For into the client address; the app never reads it."""
    res = from_ip("203.0.113.9").get("/api/health", headers={"X-Forwarded-For": "127.0.0.1"})
    assert res.status_code == 403


def test_production_serves_the_network_behind_sign_in(secure, monkeypatch):
    monkeypatch.setattr(settings, "env", "production")
    remote = from_ip("203.0.113.9")
    assert remote.get("/api/health").status_code == 200
    assert remote.get("/api/projects").status_code == 401
    assert remote.get(f"/api/share/{'t' * 24}").status_code == 404  # buyers on any network reach share links


# ---- 3b. production refuses disabled protections -------------------------------------------------------

def _prod(**kw) -> Settings:
    return Settings(env="production", admin_password_hash=SecretStr(PASSWORD_HASH),
                    session_secret=SecretStr("s" * 48), **kw)


def test_production_refuses_disabled_rate_limits_or_insecure_cookie():
    assert any("ARCHFLOW_RATE_LIMITS" in p for p in problems(_prod(rate_limits=False)))
    assert any("ARCHFLOW_COOKIE_SECURE" in p for p in problems(_prod(cookie_secure=False)))
    assert problems(_prod()) == [] and problems(_prod(rate_limits=True, cookie_secure=True)) == []
    for p in problems(_prod(rate_limits=False, cookie_secure=False)):
        assert PASSWORD_HASH not in p and "s" * 48 not in p


def test_development_may_switch_them_off():
    assert problems(Settings(env="development", rate_limits=False, cookie_secure=False)) == []


# ---- 3c. the guard runs before CORS (L1: remote preflights) ---------------------------------------------

ALLOWED = "http://localhost:3000"  # the default ARCHFLOW_CORS_ORIGINS
DISALLOWED = "https://evil.example"


def preflight(client, origin, method="DELETE", path="/api/projects"):
    return client.options(path, headers={"Origin": origin, "Access-Control-Request-Method": method,
                                         "Access-Control-Request-Headers": "x-archflow-csrf, content-type"})


@pytest.mark.parametrize("host", ["203.0.113.9", "192.168.1.20", "2001:db8::1"])
@pytest.mark.parametrize("origin", [ALLOWED, DISALLOWED])
@pytest.mark.parametrize("method", ["DELETE", "POST", "PUT"])
def test_development_refuses_remote_preflights_for_any_origin(dev_open, host, origin, method):
    res = preflight(from_ip(host), origin, method)
    assert res.status_code == 403 and res.json()["error"]["code"] == "local_only"
    assert not any(h.startswith("access-control-") for h in res.headers), dict(res.headers)


def test_development_with_sign_in_also_refuses_remote_preflights(secure):
    res = preflight(from_ip("203.0.113.9"), ALLOWED)
    assert res.status_code == 403 and "access-control-allow-origin" not in res.headers


@pytest.mark.parametrize("host", ["127.0.0.1", "::1"])
def test_local_preflights_keep_normal_cors_behaviour(dev_open, host):
    ok = preflight(from_ip(host), ALLOWED)
    assert ok.status_code == 200
    assert ok.headers["access-control-allow-origin"] == ALLOWED and ok.headers["access-control-allow-credentials"] == "true"
    assert "x-archflow-csrf" in ok.headers["access-control-allow-headers"].lower()
    bad = preflight(from_ip(host), DISALLOWED)
    assert bad.status_code == 400 and "access-control-allow-origin" not in bad.headers


def test_local_cors_on_real_requests_is_unchanged(dev_open):
    res = from_ip("127.0.0.1").get("/api/health", headers={"Origin": ALLOWED})
    assert res.status_code == 200 and res.headers["access-control-allow-origin"] == ALLOWED
    res = from_ip("127.0.0.1").get("/api/health", headers={"Origin": DISALLOWED})
    assert res.status_code == 200 and "access-control-allow-origin" not in res.headers


def test_production_answers_preflights_from_the_network_per_cors_rules(secure, monkeypatch):
    monkeypatch.setattr(settings, "env", "production")
    ok = preflight(from_ip("203.0.113.9"), ALLOWED)
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == ALLOWED
    bad = preflight(from_ip("203.0.113.9"), DISALLOWED)
    assert bad.status_code == 400 and "access-control-allow-origin" not in bad.headers


def _stack(asgi_app) -> list[str]:
    """Class names from the outside in, following the `.app` chain."""
    names, node = [], asgi_app
    while node is not None and len(names) < 20:
        names.append(type(node).__name__)
        node = getattr(node, "app", None)
    return names


def test_middleware_order_in_the_real_app_stack():
    # build_middleware_stack() is exactly what Starlette builds on the first request.
    names = _stack(app.build_middleware_stack())
    order = [names.index(n) for n in ("LocalOnlyMiddleware", "CORSMiddleware", "SecurityMiddleware", "ExceptionMiddleware")]
    assert order == sorted(order), names
    assert names.index("LocalOnlyMiddleware") == 1, names  # directly inside Starlette's ServerErrorMiddleware
    assert [m.cls.__name__ for m in app.user_middleware] == ["LocalOnlyMiddleware", "CORSMiddleware", "SecurityMiddleware"]


def test_remote_preflight_refused_through_the_app_uvicorn_loads(dev_open):
    """The ASGI app exactly as uvicorn would serve it (proxy-header middleware on, default trust), no port bound."""
    import uvicorn

    config = uvicorn.Config("app.main:app", log_config=None)
    config.load()
    assert type(config.loaded_app).__name__ == "ProxyHeadersMiddleware"
    assert config.loaded_app.app is app

    async def scenario():
        out = {}
        for label, peer, headers in [
            ("remote", "203.0.113.9", {}),
            ("remote claiming loopback", "203.0.113.9", {"X-Forwarded-For": "127.0.0.1"}),
            ("local proxy for a remote client", "127.0.0.1", {"X-Forwarded-For": "203.0.113.9"}),
            ("local", "127.0.0.1", {}),
            ("local ::1", "::1", {}),
        ]:
            transport = httpx.ASGITransport(app=config.loaded_app, client=(peer, 40000))
            async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
                r = await c.options("/api/projects", headers={**headers, "Origin": ALLOWED, "Access-Control-Request-Method": "DELETE"})
            out[label] = (r.status_code, r.headers.get("access-control-allow-origin"))
        return out

    out = asyncio.run(scenario())
    assert out["remote"] == (403, None)
    assert out["remote claiming loopback"] == (403, None)
    assert out["local proxy for a remote client"] == (403, None)
    assert out["local"] == (200, ALLOWED) and out["local ::1"] == (200, ALLOWED)
