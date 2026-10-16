"""Deployment stage 1: the security building blocks on their own (no HTTP)."""

import secrets
import threading

import pytest
from pydantic import SecretStr

from app.config import Settings
from app.security import sessions
from app.security.checks import InsecureConfiguration, check_or_raise, problems
from app.security.limits import RateLimiter, Slots
from app.security.passwords import hash_password, is_valid_hash, verify_password


# ---- passwords ------------------------------------------------------------------------------------

def test_password_hash_roundtrip_and_salting():
    pw = secrets.token_urlsafe(16)
    a, b = hash_password(pw), hash_password(pw)
    assert a != b and a.startswith("scrypt$32768$8$1$") and pw not in a
    assert verify_password(pw, a) and verify_password(pw, b)
    assert not verify_password(pw + "x", a) and not verify_password("", a)


@pytest.mark.parametrize("bad", ["", "plain", "scrypt$1$8$1$aa$bb", "bcrypt$x", "scrypt$32768$8$1$c2FsdHNhbHQ$short",
                                 "scrypt$1048576$8$1$c2FsdHNhbHQ$" + "A" * 43, "scrypt$32768$8$1$!!$!!"])
def test_malformed_or_dangerous_hashes_are_rejected(bad):
    assert not is_valid_hash(bad)
    assert not verify_password("anything", bad)


def test_empty_and_overlong_passwords_cannot_be_hashed():
    with pytest.raises(ValueError):
        hash_password("")
    with pytest.raises(ValueError):
        hash_password("x" * 1025)


# ---- sessions -------------------------------------------------------------------------------------

def _settings(**kw) -> Settings:
    base = {"admin_password_hash": SecretStr(hash_password("pw for tests")), "session_secret": SecretStr("s" * 48)}
    return Settings(**{**base, **kw})


def test_session_roundtrip_expiry_and_renewal():
    s = _settings()
    token = sessions.issue(s, now=10_000)
    claims = sessions.verify(s, token, now=10_001)
    assert claims and claims["exp"] == 10_000 + 12 * 3600
    assert sessions.verify(s, token, now=10_000 + 12 * 3600) is None  # expired
    assert sessions.verify(s, token, now=9_000) is None  # issued in the future
    assert not sessions.needs_renewal(s, claims, now=10_000 + 6 * 3600 - 1)
    assert sessions.needs_renewal(s, claims, now=10_000 + 6 * 3600 + 1)


def test_sessions_are_bound_to_secret_and_password_hash():
    s = _settings()
    token = sessions.issue(s)
    assert sessions.verify(_settings(session_secret=SecretStr("t" * 48)), token) is None
    assert sessions.verify(_settings(admin_password_hash=SecretStr(hash_password("other"))), token) is None
    assert sessions.verify(_settings(session_secret=SecretStr("")), token) is None


def test_two_sessions_differ_and_carry_no_secret():
    s = _settings()
    a, b = sessions.issue(s, now=1), sessions.issue(s, now=1)
    assert a != b and "s" * 10 not in a


# ---- startup checks -------------------------------------------------------------------------------

def test_production_without_sign_in_settings_refuses_to_start():
    with pytest.raises(InsecureConfiguration) as err:
        check_or_raise(Settings(env="production"))
    msg = str(err.value)
    assert "ARCHFLOW_ADMIN_PASSWORD_HASH" in msg and "ARCHFLOW_SESSION_SECRET" in msg


def test_half_configured_or_unsafe_settings_are_named_without_values():
    secret = "z" * 20
    found = problems(Settings(env="production", admin_password_hash=SecretStr("nonsense"), session_secret=SecretStr(secret)))
    assert len(found) == 2 and all(secret not in p and "nonsense" not in p for p in found)
    assert any("*" in p for p in problems(_settings(cors_origins="*")))


def test_valid_production_and_plain_development_start():
    check_or_raise(_settings(env="production"))
    check_or_raise(Settings(env="development"))  # sign-in off, only a warning


# ---- rate limiter ---------------------------------------------------------------------------------

def test_token_bucket_allows_capacity_then_refills():
    t = [0.0]
    rl = RateLimiter(clock=lambda: t[0])
    assert [rl.hit("b", "ip", 3, 60) for _ in range(3)] == [0, 0, 0]
    wait = rl.hit("b", "ip", 3, 60)
    assert wait == 20  # one token every 20 s
    t[0] += 19
    assert rl.hit("b", "ip", 3, 60) == 1
    t[0] += 1
    assert rl.hit("b", "ip", 3, 60) == 0


def test_buckets_and_clients_are_separate():
    rl = RateLimiter(clock=lambda: 0.0)
    assert rl.hit("upload", "a", 1, 60) == 0
    assert rl.hit("upload", "a", 1, 60) > 0
    assert rl.hit("upload", "b", 1, 60) == 0
    assert rl.hit("write", "a", 1, 60) == 0


def test_limiter_forgets_idle_clients():
    t = [0.0]
    rl = RateLimiter(clock=lambda: t[0], max_keys=3)
    for ip in "abc":
        rl.hit("b", ip, 5, 60)
    t[0] += 90_000
    rl.hit("b", "d", 5, 60)
    rl.hit("b", "e", 5, 60)
    assert len(rl._buckets) <= 3


def test_zero_capacity_always_refuses():
    assert RateLimiter(clock=lambda: 0.0).hit("b", "ip", 0, 60) == 60


# ---- slots ----------------------------------------------------------------------------------------

def test_slots_cap_and_idempotent_release():
    slots = Slots()
    a, b = slots.try_acquire(2), slots.try_acquire(2)
    assert a and b and slots.try_acquire(2) is None
    a.release()
    a.release()  # second release must not free someone else's slot
    assert slots.in_use == 1
    c = slots.try_acquire(2)
    assert c and slots.try_acquire(2) is None
    b.release()
    c.release()
    assert slots.in_use == 0


def test_slots_are_thread_safe():
    slots = Slots()
    got = []
    barrier = threading.Barrier(16)

    def grab():
        barrier.wait()
        got.append(slots.try_acquire(3))

    threads = [threading.Thread(target=grab) for _ in range(16)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()
    assert sum(1 for s in got if s) == 3 and slots.in_use == 3
