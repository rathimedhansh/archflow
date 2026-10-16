from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_ok():
    res = client.get("/api/health")
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "ok"
    assert body["service"] == "ARCHFLOW API"


def test_cors_allows_frontend_origin():
    res = client.get("/api/health", headers={"Origin": "http://localhost:3000"})
    assert res.headers["access-control-allow-origin"] == "http://localhost:3000"
