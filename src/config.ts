import { homedir } from "node:os";
import { join } from "node:path";

export const LOOPBACK_HOST = "127.0.0.1";
export const FIRST_PORT = 7717;
export const ATTACH_GRACE_MS = 60_000;
export const AGENT_HEADER = "x-hub-agent";
export const SOURCE_HEADER = "x-hub-source";

export function addressOverride(): string | undefined {
  return process.env.DJT_HUB_ADDR || undefined;
}

export function dataDir(): string {
  return process.env.DJT_HUB_DATA || join(homedir(), ".local", "share", "djt-hub");
}

// Tests turn the view host off so each server skips booting Vite.
export function viewsEnabled(): boolean {
  return process.env.DJT_HUB_VIEWS !== "off";
}
