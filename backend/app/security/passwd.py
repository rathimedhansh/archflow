"""Create the developer password hash for ARCHFLOW_ADMIN_PASSWORD_HASH.

    cd backend
    .\\.venv\\Scripts\\python -m app.security.passwd

Asks for the password twice (nothing is shown while typing) and prints only its hash. The password
itself is not stored, logged or sent anywhere. Put the printed line into the backend's environment.
"""

import getpass
import sys

from app.security.passwords import hash_password

MIN_LENGTH = 12


def main() -> int:
    password = getpass.getpass(f"New ARCHFLOW developer password (at least {MIN_LENGTH} characters): ")
    if len(password) < MIN_LENGTH:
        print(f"Too short: use at least {MIN_LENGTH} characters.", file=sys.stderr)
        return 1
    if getpass.getpass("Repeat it: ") != password:
        print("The two entries differ. Nothing was created.", file=sys.stderr)
        return 1
    print(hash_password(password))
    print("\nSet this as ARCHFLOW_ADMIN_PASSWORD_HASH. Also set ARCHFLOW_SESSION_SECRET, e.g. to the output of:\n"
          '  python -c "import secrets; print(secrets.token_urlsafe(48))"', file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
