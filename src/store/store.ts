import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setPath, type JsonObject } from "../state/path.ts";

export type Hub = {
  id: string;
  title: string;
  created_at: number;
  closed_at: number | null;
};

export type HubEvent = {
  seq: number;
  hub: string;
  source: string;
  type: string;
  payload: unknown;
  ts: number;
};

export type PatchOperation = { path: string; value: unknown };

export class HubNotFoundError extends Error {}
export class HubExistsError extends Error {}

const HUB_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertHubId(hubId: string): void {
  if (!HUB_ID_PATTERN.test(hubId)) {
    throw new Error(`hub id "${hubId}" must be a lowercase slug (a-z, 0-9, -)`);
  }
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporaryPath, filePath);
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

// Each hub is a folder of plain files. The server is their only writer, except
// view.tsx, which the agent edits directly.
export class HubStore {
  readonly hubsDir: string;
  private lastSeqByHub = new Map<string, number>();

  constructor(dataDir: string) {
    this.hubsDir = join(dataDir, "hubs");
    mkdirSync(this.hubsDir, { recursive: true });
  }

  hubDir(hubId: string): string {
    return join(this.hubsDir, hubId);
  }

  viewPath(hubId: string): string {
    return join(this.hubDir(hubId), "view.tsx");
  }

  createHub(hubId: string, title: string, viewSource: string): Hub {
    assertHubId(hubId);
    if (existsSync(this.hubDir(hubId))) throw new HubExistsError(`hub ${hubId} already exists`);
    mkdirSync(this.hubDir(hubId), { recursive: true });
    const hub: Hub = { id: hubId, title: title || hubId, created_at: Date.now(), closed_at: null };
    writeJsonAtomically(this.file(hubId, "hub.json"), hub);
    writeJsonAtomically(this.file(hubId, "state.json"), {});
    writeFileSync(this.file(hubId, "events.jsonl"), "");
    writeFileSync(this.viewPath(hubId), viewSource);
    return hub;
  }

  listHubs(includeClosed: boolean): Hub[] {
    const hubs = readdirSync(this.hubsDir)
      .filter((name) => existsSync(this.file(name, "hub.json")))
      .map((name) => readJson<Hub>(this.file(name, "hub.json")));
    const visibleHubs = includeClosed ? hubs : hubs.filter((hub) => hub.closed_at === null);
    return visibleHubs.sort((left, right) => right.created_at - left.created_at);
  }

  getHub(hubId: string): Hub {
    assertHubId(hubId);
    const hubFile = this.file(hubId, "hub.json");
    if (!existsSync(hubFile)) throw new HubNotFoundError(`hub ${hubId} not found`);
    return readJson<Hub>(hubFile);
  }

  closeHub(hubId: string): Hub {
    const hub = this.getHub(hubId);
    if (hub.closed_at === null) {
      hub.closed_at = Date.now();
      writeJsonAtomically(this.file(hubId, "hub.json"), hub);
    }
    return hub;
  }

  deleteHub(hubId: string): void {
    this.getHub(hubId);
    rmSync(this.hubDir(hubId), { recursive: true, force: true });
    this.lastSeqByHub.delete(hubId);
  }

  getState(hubId: string): JsonObject {
    this.getHub(hubId);
    return readJson<JsonObject>(this.file(hubId, "state.json"));
  }

  // Applies every operation or none: a bad path leaves state.json untouched.
  patchState(hubId: string, operations: PatchOperation[]): JsonObject {
    const state = this.getState(hubId);
    for (const operation of operations) setPath(state, operation.path, operation.value);
    writeJsonAtomically(this.file(hubId, "state.json"), state);
    return state;
  }

  appendEvent(hubId: string, source: string, type: string, payload: unknown): HubEvent {
    this.getHub(hubId);
    const event: HubEvent = {
      seq: this.lastSeq(hubId) + 1,
      hub: hubId,
      source,
      type,
      payload: payload ?? {},
      ts: Date.now(),
    };
    appendFileSync(this.file(hubId, "events.jsonl"), JSON.stringify(event) + "\n");
    this.lastSeqByHub.set(hubId, event.seq);
    return event;
  }

  listEvents(hubId: string, sinceSeq = 0): HubEvent[] {
    this.getHub(hubId);
    return this.readEvents(hubId).filter((event) => event.seq > sinceSeq);
  }

  lastSeq(hubId: string): number {
    const cachedSeq = this.lastSeqByHub.get(hubId);
    if (cachedSeq !== undefined) return cachedSeq;
    const lastEvent = this.readEvents(hubId).at(-1);
    const seq = lastEvent?.seq ?? 0;
    this.lastSeqByHub.set(hubId, seq);
    return seq;
  }

  private readEvents(hubId: string): HubEvent[] {
    return readFileSync(this.file(hubId, "events.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as HubEvent);
  }

  private file(hubId: string, name: string): string {
    return join(this.hubDir(hubId), name);
  }
}
