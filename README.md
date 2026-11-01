# ARCHFLOW

**Turn 2D floor plans into interactive 3D spaces.**

ARCHFLOW is a web-based tool for transforming architectural floor plans into structured layouts and interactive 3D experiences. Explore a property in 3D, inspect the layout, and walk through the space directly in your browser.

> **Status:** In active development

## Features

- **Floor-plan upload** — Upload a floor plan to start a project.
- **2D-to-3D conversion** — Convert supported floor plans into structured layouts and 3D geometry.
- **Interactive 3D viewer** — Rotate, zoom, and pan around the generated model.
- **First-person walkthrough** — Navigate through the space using desktop controls.
- **Shareable property views** — Open a shared property page without needing to edit the project.
- **Browser-based experience** — Explore the generated space without installing a dedicated application.

## How it works

1. Upload a 2D floor plan.
2. ARCHFLOW processes the plan into a structured representation.
3. The geometry engine creates a 3D model.
4. Explore the result in the interactive viewer or first-person walkthrough.

## Tech stack

- **Frontend:** Next.js, React, TypeScript
- **3D:** Three.js, React Three Fiber, Drei
- **Computer vision / backend:** Python, FastAPI, OpenCV
- **Testing:** Vitest, Playwright, pytest

## Getting started

### Prerequisites

Install the versions of Node.js and Python supported by the project.

### Run locally

The frontend and backend are separate services. Use the setup instructions and environment variables defined in the repository.

```bash
# Frontend
cd frontend
npm install
npm run dev