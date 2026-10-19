import { AGENT_HEADER, daemonAddress } from "../config.ts";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function baseUrl(): string {
  return `http://${daemonAddress()}`;
}

export function hubUrl(hubId: string): string {
  return `${baseUrl()}/h/${hubId}`;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/api${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(`djt-hub daemon not reachable at ${daemonAddress()} (run: djt-hub status)`, 0);
  }
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(result.error ?? response.statusText, response.status);
  return result;
}

export type StreamFrame = { event: string; data: any };

// Yields SSE frames from an agent stream. The agent header marks the hub
// attached for as long as this stream stays open.
export async function* agentStream(hubId: string, sinceSeq: number | undefined, signal: AbortSignal): AsyncGenerator<StreamFrame> {
  const query = sinceSeq === undefined ? "" : `?since=${sinceSeq}`;
  const response = await fetch(`${baseUrl()}/api/hubs/${hubId}/stream${query}`, {
    headers: { [AGENT_HEADER]: "1" },
    signal,
  });
  if (!response.ok) {
    const result = (await response.json()) as { error?: string };
    throw new ApiError(result.error ?? response.statusText, response.status);
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body!) {
    buffer += decoder.decode(chunk, { stream: true });
    let frameEnd = buffer.indexOf("\n\n");
    while (frameEnd >= 0) {
      const lines = buffer.slice(0, frameEnd).split("\n");
      buffer = buffer.slice(frameEnd + 2);
      const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
      const data = lines.find((line) => line.startsWith("data:"))?.slice(5);
      if (event !== "ping" && data !== undefined) yield { event, data: JSON.parse(data) };
      frameEnd = buffer.indexOf("\n\n");
    }
  }
}
