import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "djt-hub-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export type SseMessage = { event: string; data: any };

// Reads SSE frames from a streaming response until `count` frames of the wanted
// kinds have arrived. Pings are skipped.
export async function readSse(response: Response, count: number): Promise<SseMessage[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const messages: SseMessage[] = [];
  let buffer = "";
  while (messages.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let frameEnd = buffer.indexOf("\n\n");
    while (frameEnd >= 0) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      const eventLine = frame.split("\n").find((line) => line.startsWith("event:"));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      const event = eventLine?.slice(6).trim() ?? "message";
      if (event !== "ping" && dataLine) messages.push({ event, data: JSON.parse(dataLine.slice(5)) });
      frameEnd = buffer.indexOf("\n\n");
    }
  }
  reader.releaseLock();
  return messages;
}
