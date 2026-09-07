/**
 * Minimal Diversion REST API client.
 *
 * The dvk_ personal API token (Diversion web app → Settings → Integrations)
 * is read from DV_API_TOKEN / DIVERSION_API_TOKEN. Base URL can be overridden
 * with DIVERSION_API_URL (default https://api.diversion.dev/v0).
 */

const API_BASE = process.env.DIVERSION_API_URL ?? "https://api.diversion.dev/v0";

export function apiToken(): string | null {
  const t = process.env.DV_API_TOKEN ?? process.env.DIVERSION_API_TOKEN;
  return t && t.trim() ? t.trim() : null;
}

export function tokenHelp(): string {
  return [
    "The Diversion REST API needs a personal API token (dvk_...):",
    "Diversion web app → avatar → Settings → Integrations → 'Generate a new API token'.",
    'Then start the GUI with DV_API_TOKEN=dvk_... in the environment.',
    "(API access may require a paid plan tier; opening reviews via the dv CLI works without a token.)",
  ].join("\n");
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function dvApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const token = apiToken();
  if (!token) throw new ApiError(0, tokenHelp());
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ApiError(0, `Network error calling Diversion API (${API_BASE}${path}): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { detail?: string } | null;
    const hint =
      res.status === 401
        ? " — token invalid or expired"
        : res.status === 402 || res.status === 403
          ? " — your plan tier may not include API access"
          : "";
    throw new ApiError(res.status, `HTTP ${res.status}${hint}${body?.detail ? `\n${body.detail}` : ""}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface User {
  id?: string;
  name?: string;
  full_name?: string;
  email?: string;
}

export interface Review {
  id: string;
  title: string;
  description?: string;
  status: "open" | "closed";
  author?: User | null;
  reviewers?: User[] | null;
  reviewer_statuses?: { user_id: string; status: string; updated_at: number }[] | null;
  created_at: number;
  updated_at: number;
  base_ref: string;
  compare_ref: string;
  repo_id: string;
  merge_commit_id?: number | string;
  active_merge_id?: string;
}

export interface ReviewComment {
  id: string;
  thread_id: string;
  author?: User | null;
  content: string;
  created_at: number;
  updated_at: number;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  start_side?: "left" | "right";
  end_side?: "left" | "right";
}
