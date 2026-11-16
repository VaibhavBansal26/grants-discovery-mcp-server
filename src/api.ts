const GRANTS_BASE = "https://api.grants.gov/v1/api";
const USASPENDING_BASE = "https://api.usaspending.gov/api/v2";
const USER_AGENT = "grants-discovery-mcp-server/0.1.0";

export class ApiError extends Error {
  constructor(readonly status: number, source: string) {
    super(httpErrorMessage(status, source));
  }
}

function httpErrorMessage(status: number, source: string): string {
  switch (status) {
    case 400:
    case 422:
      return `${source} rejected the request (HTTP ${status}). Check filter values; use grants_list_filter_options for valid codes.`;
    case 404:
      return `${source}: not found. Check the ID; grants_search_opportunities returns valid opportunity IDs.`;
    case 429:
      return `${source} rate limit exceeded. Wait a minute and retry.`;
    default:
      return `${source} returned HTTP ${status}. It may be temporarily unavailable; try again shortly.`;
  }
}

async function post<T>(url: string, body: unknown, source: string, signal: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new Error(`${source} did not respond within 30 seconds. Try again or narrow the query.`);
    }
    throw error;
  }
  if (!response.ok) throw new ApiError(response.status, source);
  return (await response.json()) as T;
}

export interface GrantsEnvelope<T> {
  errorcode: number;
  msg: string;
  data: T;
}

export async function grantsPost<T>(endpoint: string, body: unknown, signal: AbortSignal): Promise<T> {
  const res = await post<GrantsEnvelope<T>>(`${GRANTS_BASE}/${endpoint}`, body, "Grants.gov", signal);
  if (res.errorcode !== 0) throw new Error(`Grants.gov error: ${res.msg}`);
  return res.data;
}

export function usaspendingPost<T>(path: string, body: unknown, signal: AbortSignal): Promise<T> {
  return post<T>(`${USASPENDING_BASE}/${path}`, body, "USAspending", signal);
}
