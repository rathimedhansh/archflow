/** Typed client for the ARCHFLOW backend. All backend calls go through here. */
import type { FloorPlanData } from "@/lib/floorplan/types";
import { parseStreamLine, readLines, type StreamMessage } from "@/lib/interpretation/stream";

export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
}

export interface FloorPlan {
  id: string;
  original_filename: string;
  source_format: string;
  width: number;
  height: number;
  size_bytes: number;
  status: string;
  created_at: string;
  /** The property project this plan belongs to (M7); null for a plan uploaded on its own. */
  project_id?: string | null;
  /** Path relative to the API base; use `absoluteUrl()` for <img src>. */
  image_url: string;
}

export interface ProjectFloorPlan {
  id: string;
  original_filename: string;
  width: number;
  height: number;
  image_url: string;
}

export interface PlanSummary {
  saved: boolean;
  saved_at: string | null;
  damaged: boolean;
  auto_detected: boolean;
  provenance: string | null;
  calibrated: boolean;
  walls: number;
  rooms: number;
  doors: number;
  windows: number;
  floor_area_m2: number;
}

export interface ShareSummary {
  token: string;
  /** Frontend path of the buyer page, e.g. `/share/<token>`. */
  url_path: string;
  published_at: string;
  /** The published snapshot equals the currently saved plan. */
  up_to_date: boolean;
}

export interface Project {
  id: string;
  name: string;
  address: string;
  description: string;
  created_at: string;
  updated_at: string;
  floorplan: ProjectFloorPlan | null;
  plan: PlanSummary | null;
  share: ShareSummary | null;
}

export interface ProjectFields {
  name: string;
  address?: string;
  description?: string;
}

/** What a buyer's share link returns. `plan` is untrusted JSON: pass it through `prepareModel`. */
export interface SharedProperty {
  property: { name: string; address: string; description: string };
  plan: unknown;
  published_at: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const absoluteUrl = (path: string) => `${API_BASE_URL}${path}`;

const NETWORK_MESSAGE =
  "Cannot reach the ARCHFLOW backend. Is it running on " + API_BASE_URL + "?";

/** Turn an error response body into an ApiError. Handles our shape and FastAPI's default. */
function toApiError(status: number, body: unknown): ApiError {
  const b = body as {
    error?: { code?: string; message?: string };
    detail?: unknown;
  } | null;
  if (b?.error?.message) return new ApiError(b.error.message, status, b.error.code);
  if (typeof b?.detail === "string") return new ApiError(b.detail, status);
  if (Array.isArray(b?.detail) && b.detail.length > 0) {
    // FastAPI/pydantic validation errors: [{ loc, msg }]. Pydantic prefixes "Value error, ".
    const msgs = (b.detail as { msg?: string }[])
      .map((d) => d.msg?.replace(/^Value error, /, ""))
      .filter(Boolean);
    if (msgs.length) return new ApiError(msgs.slice(0, 3).join(" "), status, "validation_error");
  }
  return new ApiError(`Request failed (${status}).`, status);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(absoluteUrl(path), init);
  } catch {
    throw new ApiError(NETWORK_MESSAGE);
  }
  if (!res.ok) {
    throw toApiError(res.status, await res.json().catch(() => null));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

/** Upload uses XHR (not fetch) because fetch cannot report upload progress. */
function uploadFloorPlan(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<FloorPlan> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", absoluteUrl("/api/floorplans"));
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError(NETWORK_MESSAGE));
    xhr.onabort = () => reject(new ApiError("Upload cancelled."));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as FloorPlan);
      else reject(toApiError(xhr.status, xhr.response));
    };
    const form = new FormData();
    form.append("file", file);
    xhr.send(form);
  });
}

/**
 * Run automatic detection. `onMessage` receives each progress/result line as it arrives
 * (fetch streaming; the response is NDJSON). Resolves when the stream ends.
 */
async function interpret(id: string, onMessage: (msg: StreamMessage) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(absoluteUrl(`/api/floorplans/${encodeURIComponent(id)}/interpret`), { method: "POST", signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError(NETWORK_MESSAGE);
  }
  if (!res.ok) throw toApiError(res.status, await res.json().catch(() => null));
  if (!res.body) throw new ApiError("The server sent no data.");
  await readLines(res.body, (line) => {
    const msg = parseStreamLine(line);
    if (msg) onMessage(msg);
  });
}

export const api = {
  health: () => request<HealthResponse>("/api/health", { cache: "no-store" }),
  uploadFloorPlan,
  getStructure: (id: string) =>
    request<FloorPlanData>(`/api/floorplans/${encodeURIComponent(id)}/structure`, {
      cache: "no-store",
    }),
  saveStructure: (id: string, plan: FloorPlanData) =>
    request<FloorPlanData>(`/api/floorplans/${encodeURIComponent(id)}/structure`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(plan),
    }),
  getFloorPlan: (id: string) =>
    request<FloorPlan>(`/api/floorplans/${encodeURIComponent(id)}`, {
      cache: "no-store",
    }),
  interpret,
  /** The last automatic result as raw JSON: validate with `acceptInterpretation` before use. */
  getInterpretation: (id: string) =>
    request<unknown>(`/api/floorplans/${encodeURIComponent(id)}/interpretation`, {
      cache: "no-store",
    }),

  // ---- projects (M7) ----
  listProjects: () => request<Project[]>("/api/projects", { cache: "no-store" }),
  getProject: (id: string) => request<Project>(projectPath(id), { cache: "no-store" }),
  createProject: (fields: ProjectFields) => request<Project>("/api/projects", json("POST", fields)),
  updateProject: (id: string, fields: Partial<ProjectFields>) => request<Project>(projectPath(id), json("PATCH", fields)),
  deleteProject: (id: string) => request<void>(projectPath(id), { method: "DELETE" }),
  attachFloorPlan: (id: string, floorplanId: string) =>
    request<Project>(`${projectPath(id)}/floorplan`, json("PUT", { floorplan_id: floorplanId })),
  publishShare: (id: string) => request<Project>(`${projectPath(id)}/share`, { method: "POST" }),
  unpublishShare: (id: string) => request<Project>(`${projectPath(id)}/share`, { method: "DELETE" }),
  /** Public, read-only: the buyer page's data. */
  getSharedProperty: (token: string) =>
    request<SharedProperty>(`/api/share/${encodeURIComponent(token)}`, { cache: "no-store" }),
};
