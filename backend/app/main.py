from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import auth, floorplans, health, interpretation, projects, structure
from app.config import settings
from app.errors import ArchflowError, archflow_error_handler
from app.security.checks import check_or_raise
from app.security.middleware import LocalOnlyMiddleware, SecurityMiddleware

check_or_raise(settings)

app = FastAPI(title=settings.app_name, version=settings.version)

# Each add_middleware wraps everything added before it, so the LAST one added runs FIRST.
# Resulting order, outermost first: LocalOnly -> CORS -> Security -> routes (pinned by a test).
# Security runs inside CORS: its 401/403/429 answers still carry CORS headers.
app.add_middleware(SecurityMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,  # the session cookie, when the frontend runs on another port/origin
    allow_methods=["*"],
    allow_headers=["*"],
)
# Outermost: in development, other machines are refused before CORS could answer a preflight.
app.add_middleware(LocalOnlyMiddleware)

app.add_exception_handler(ArchflowError, archflow_error_handler)

app.include_router(health.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(floorplans.router, prefix="/api")
app.include_router(structure.router, prefix="/api")
app.include_router(interpretation.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
