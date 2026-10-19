import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../config.ts";

export type ServerRecord = { address: string; pid: number };

const SERVER_FILE_NAME = "server.json";

function serverFilePath(hubId: string): string {
  return join(dataDir(), "hubs", hubId, SERVER_FILE_NAME);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writeServerFile(hubId: string, record: ServerRecord): void {
  writeFileSync(serverFilePath(hubId), JSON.stringify(record) + "\n");
}

export function removeServerFile(hubId: string): void {
  rmSync(serverFilePath(hubId), { force: true });
}

// A record whose process has died counts as not up, so a crash never strands
// a hub behind a stale file.
export function readLiveServer(hubId: string): ServerRecord | undefined {
  let record: ServerRecord;
  try {
    record = JSON.parse(readFileSync(serverFilePath(hubId), "utf8"));
  } catch {
    return undefined;
  }
  return isProcessAlive(record.pid) ? record : undefined;
}
