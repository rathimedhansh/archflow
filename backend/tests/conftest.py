"""Shared test setup.

In development mode the API answers only loopback clients. Starlette's TestClient reports its peer as
the placeholder host "testclient", which is (correctly) not loopback, so tests talk to the app from
127.0.0.1 like a local browser. Tests about other machines pass `client=(address, port)` explicitly.
"""

import starlette.testclient

_init = starlette.testclient.TestClient.__init__


def _loopback_init(self, *args, client=("127.0.0.1", 50000), **kwargs):
    _init(self, *args, client=client, **kwargs)


starlette.testclient.TestClient.__init__ = _loopback_init
