import type { ClaimRequest, ClaimResponse, PublicJob } from "./types";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "/api";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ApiError(payload.error ?? `Request failed: ${response.status}`, response.status);
  }
  return payload as T;
}

export function listJobs() {
  return request<PublicJob[]>("/jobs");
}

export function claimJob(jobId: string, claim: ClaimRequest) {
  return request<ClaimResponse>(`/jobs/${encodeURIComponent(jobId)}/claims`, {
    method: "POST",
    body: JSON.stringify(claim),
  });
}
