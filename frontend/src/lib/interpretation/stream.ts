/**
 * The progress stream of `POST /api/floorplans/{id}/interpret` (NDJSON, one message per line).
 *
 * Every line is untrusted: a line that is not a known message is ignored, never thrown on,
 * so a proxy that injects noise or a truncated response cannot break the upload page.
 */
import { CV_STAGES, type CvStageId } from "./types";

export type StreamMessage =
  | { type: "stage"; stage: CvStageId; status: "started" | "done"; summary: string; ms: number }
  | { type: "result"; interpretation: unknown }
  | { type: "error"; message: string };

const STAGE_IDS = new Set<string>(CV_STAGES.map((s) => s.id));
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseStreamLine(line: string): StreamMessage | null {
  const text = line.trim();
  if (!text) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(raw)) return null;
  if (raw.type === "stage" && typeof raw.stage === "string" && STAGE_IDS.has(raw.stage)
    && (raw.status === "started" || raw.status === "done")) {
    return {
      type: "stage", stage: raw.stage as CvStageId, status: raw.status,
      summary: typeof raw.summary === "string" ? raw.summary.slice(0, 200) : "",
      ms: typeof raw.ms === "number" && Number.isFinite(raw.ms) && raw.ms >= 0 ? raw.ms : 0,
    };
  }
  if (raw.type === "result" && "interpretation" in raw) return { type: "result", interpretation: raw.interpretation };
  if (raw.type === "error") {
    return { type: "error", message: typeof raw.message === "string" && raw.message ? raw.message.slice(0, 300) : "Automatic detection failed." };
  }
  return null;
}

/** Split a byte stream into lines, calling `onLine` for each complete one (and the unterminated tail). */
export async function readLines(body: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) onLine(buffer);
}

export type StageStatus = "pending" | "running" | "done";
export interface StageProgress {
  id: CvStageId;
  label: string;
  status: StageStatus;
  summary: string;
}

export const initialProgress = (): StageProgress[] =>
  CV_STAGES.map((s) => ({ id: s.id, label: s.label, status: "pending", summary: "" }));

/** Apply one stage message. Stages are strictly ordered: starting one completes the ones before it. */
export function applyStage(progress: StageProgress[], msg: Extract<StreamMessage, { type: "stage" }>): StageProgress[] {
  const index = progress.findIndex((s) => s.id === msg.stage);
  if (index < 0) return progress;
  return progress.map((s, i) => {
    if (i < index && s.status !== "done") return { ...s, status: "done" };
    if (i !== index) return s;
    return msg.status === "done" ? { ...s, status: "done", summary: msg.summary } : { ...s, status: "running" };
  });
}
