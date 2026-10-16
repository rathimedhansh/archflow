from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import floorplans, health, interpretation, projects, structure
from app.config import settings
from app.errors import ArchflowError, archflow_error_handler

app = FastAPI(title=settings.app_name, version=settings.version)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.add_exception_handler(ArchflowError, archflow_error_handler)

app.include_router(health.router, prefix="/api")
app.include_router(floorplans.router, prefix="/api")
app.include_router(structure.router, prefix="/api")
app.include_router(interpretation.router, prefix="/api")
app.include_router(projects.router, prefix="/api")
