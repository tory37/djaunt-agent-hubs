import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_ADDRESS = "127.0.0.1:7717";
export const ATTACH_GRACE_MS = 60_000;
export const AGENT_HEADER = "x-hub-agent";
export const SOURCE_HEADER = "x-hub-source";

export function daemonAddress(): string {
  return process.env.DJT_HUB_ADDR || DEFAULT_ADDRESS;
}

export function dataDir(): string {
  return process.env.DJT_HUB_DATA || join(homedir(), ".local", "share", "djt-hub");
}
