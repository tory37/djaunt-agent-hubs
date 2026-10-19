import { addressOverride, AGENT_HEADER } from "../config.ts";
import { readLiveServer } from "./server-file.ts";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class HubNotUpError extends Error {
  constructor(hubId: string) {
    super(`hub ${hubId} is not up (run: djt-hub up ${hubId})`);
  }
}

// Each hub is served by the process that ran `up` for it; its server file
// says where.
export function hubAddress(hubId: string): string {
  const address = addressOverride() ?? readLiveServer(hubId)?.address;
  if (address === undefined) throw new HubNotUpError(hubId);
  return address;
}

export function hubUrl(hubId: string): string {
  return `http://${hubAddress(hubId)}/h/${hubId}`;
}

export async function api<T = unknown>(hubId: string, method: string, path: string, body?: unknown): Promise<T> {
  const address = hubAddress(hubId);
  let response: Response;
  try {
    response = await fetch(`http://${address}/api${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(`hub ${hubId} server not reachable at ${address}`, 0);
  }
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new ApiError(result.error ?? response.statusText, response.status);
  return result;
}

export type StreamFrame = { event: string; data: any };

// Yields SSE frames from an agent stream. The agent header marks the hub
// attached for as long as this stream stays open.
export async function* agentStream(
  hubId: string,
  sinceSeq: number | undefined,
  signal: AbortSignal,
  address = hubAddress(hubId),
): AsyncGenerator<StreamFrame> {
  const query = sinceSeq === undefined ? "" : `?since=${sinceSeq}`;
  const response = await fetch(`http://${address}/api/hubs/${hubId}/stream${query}`, {
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
