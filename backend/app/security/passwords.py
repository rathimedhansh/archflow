"""Password hashing with scrypt (standard library only).

Encoded form, safe to put in an environment variable:

    scrypt$<n>$<r>$<p>$<salt, base64url>$<hash, base64url>

Only the hash is ever stored; the password itself is never written anywhere.
"""

import base64
import hashlib
import hmac
import secrets

N, R, P = 2**15, 8, 1
_DKLEN = 32
_MAXMEM = 64 * 1024 * 1024  # scrypt needs 128 * n * r bytes (32 MiB for the defaults)
MAX_PASSWORD_LENGTH = 1024


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _derive(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, maxmem=_MAXMEM, dklen=_DKLEN)


def hash_password(password: str) -> str:
    if not password:
        raise ValueError("The password must not be empty.")
    if len(password) > MAX_PASSWORD_LENGTH:
        raise ValueError(f"The password must be at most {MAX_PASSWORD_LENGTH} characters.")
    salt = secrets.token_bytes(16)
    return f"scrypt${N}${R}${P}${_b64(salt)}${_b64(_derive(password, salt, N, R, P))}"


def _parse(encoded: str) -> tuple[int, int, int, bytes, bytes] | None:
    parts = encoded.strip().split("$")
    if len(parts) != 6 or parts[0] != "scrypt":
        return None
    try:
        n, r, p = int(parts[1]), int(parts[2]), int(parts[3])
        salt, digest = _unb64(parts[4]), _unb64(parts[5])
    except ValueError:
        return None
    # Accept only sane parameters, so a bad setting cannot make every sign-in exhaust memory.
    if not (2**10 <= n <= 2**17 and n & (n - 1) == 0 and 1 <= r <= 16 and 1 <= p <= 4):
        return None
    if 128 * n * r > _MAXMEM or len(salt) < 8 or len(digest) != _DKLEN:
        return None
    return n, r, p, salt, digest


def is_valid_hash(encoded: str) -> bool:
    return _parse(encoded) is not None


def verify_password(password: str, encoded: str) -> bool:
    parsed = _parse(encoded)
    if parsed is None or not password or len(password) > MAX_PASSWORD_LENGTH:
        return False
    n, r, p, salt, digest = parsed
    return hmac.compare_digest(_derive(password, salt, n, r, p), digest)
