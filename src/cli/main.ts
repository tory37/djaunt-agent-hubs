#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { dataDir, FIRST_PORT, LOOPBACK_HOST, viewsEnabled } from "../config.ts";
import { parseMatchers, payloadMatches } from "../state/match.ts";
import { HubNotFoundError, HubStore, type HubEvent } from "../store/store.ts";
import { DEFAULT_VIEW_SOURCE } from "../view-template.ts";
import {
  flag,
  flagList,
  hasFlag,
  parseArgs,
  parseDuration,
  parseValue,
  resolveHub,
  UsageError,
  type ParsedArgs,
} from "./args.ts";
import { agentStream, api, ApiError, HubNotUpError, hubUrl } from "./client.ts";
import { lanAddresses } from "../server/lan.ts";
import { readLiveServer, removeServerFile, writeServerFile } from "./server-file.ts";

const EXIT_ERROR = 1;
const EXIT_TIMEOUT = 2;
const EXIT_USAGE = 64;
const RECONNECT_DELAY_MS = 1_000;
const USER_SOURCE = "user";

const USAGE = `djt-hub — live local pages that an agent builds and attaches to

Serve
  up <hub> [--title T] [--port N] [--all] [--lan]
                                       serve the hub and attach to it. The first
                                       line is {"hub","url","view_path","address"};
                                       each later line is one user event. The page
                                       goes down when this process stops.
                                       --lan also serves private-network machines
                                       and adds "lan_urls"; public peers are dropped.
  docs                                 print the agent guide

Hubs
  ls [--all]                           list hubs and the URL of each one that is up
  show <hub>                           hub, state, attached, last event seq
  open <hub>                           open the hub in the browser
  close <hub>                          close the hub; its up process exits
  delete <hub>                         remove a hub and all its files

State
  patch <hub> path=value...            values parse as JSON, else string
  patch <hub> --json <json|-|@file>    [{"path":"a.b","value":1}, ...]
  get <hub> [path]                     print state, or one value

Events
  wait <hub> [--type T] [--match k=v]... [--since N] [--timeout 30m]
                                       attach until one matching event; exit 2 on timeout
  emit <hub> <type> [json]             append an agent event
  events <hub> [--since N] [--type T]  print event history

Hub resolution: --hub, then $DJT_HUB_ID, then the first argument.
Every command but up, ls, delete and docs needs the hub to be up.
`;

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printLine(value: unknown): void {
  console.log(JSON.stringify(value));
}

function readJsonArgument(argument: string): unknown {
  if (argument === "-") return JSON.parse(readFileSync(0, "utf8"));
  if (argument.startsWith("@")) return JSON.parse(readFileSync(argument.slice(1), "utf8"));
  return JSON.parse(argument);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

type FollowOptions = { hubId: string; sinceSeq?: number; signal: AbortSignal; address?: string };

// Streams events and reconnects across dropped connections, resuming after
// the last seen seq. Ends when the hub closes or the signal aborts, and fails
// once the hub's up process is gone.
async function* followEvents({ hubId, sinceSeq, signal, address }: FollowOptions): AsyncGenerator<HubEvent> {
  let lastSeenSeq = sinceSeq;
  while (!signal.aborted) {
    try {
      for await (const frame of agentStream(hubId, lastSeenSeq, signal, address)) {
        if (frame.event === "init" && lastSeenSeq === undefined) lastSeenSeq = frame.data.last_seq;
        if (frame.event === "hub" && frame.data.hub.closed_at !== null) return;
        if (frame.event === "event") {
          lastSeenSeq = frame.data.event.seq;
          yield frame.data.event as HubEvent;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError || error instanceof HubNotUpError) throw error;
    }
    await sleep(RECONNECT_DELAY_MS);
  }
}

function optionalSeq(parsed: ParsedArgs): number | undefined {
  const sinceText = flag(parsed, "since");
  return sinceText === undefined ? undefined : Number(sinceText);
}

function hubExists(store: HubStore, hubId: string): boolean {
  try {
    store.getHub(hubId);
    return true;
  } catch (error) {
    if (error instanceof HubNotFoundError) return false;
    throw error;
  }
}

async function startOnPort(port: number, lan: boolean) {
  const { startServer } = await import("../server/serve.ts");
  return startServer({ address: `${LOOPBACK_HOST}:${port}`, dataDir: dataDir(), withViews: viewsEnabled(), lan });
}

// Another up can take the probed port before this one binds it, so a taken
// port moves the search on instead of failing.
async function startOnFreePort(lan: boolean) {
  const { findFreePort, isPortTaken } = await import("../server/serve.ts");
  let nextPort = FIRST_PORT;
  for (;;) {
    const port = await findFreePort(LOOPBACK_HOST, nextPort, lan);
    try {
      return await startOnPort(port, lan);
    } catch (error) {
      if (!isPortTaken(error)) throw error;
      nextPort = port + 1;
    }
  }
}

function abortOnSignals(controller: AbortController): void {
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
}

async function guideText(): Promise<string> {
  return readFileSync(new URL("../../docs/agent-guide.md", import.meta.url), "utf8");
}

const commands: Record<string, (args: string[]) => Promise<number | void>> = {
  async up(args) {
    const parsed = parseArgs(args, ["all", "lan"]);
    const { hubId } = resolveHub(parsed, "up <hub> [--title T] [--port N] [--all] [--lan]");
    const liveServer = readLiveServer(hubId);
    if (liveServer) throw new Error(`hub ${hubId} is already up at http://${liveServer.address}/h/${hubId}`);

    const portText = flag(parsed, "port");
    const lan = hasFlag(parsed, "lan");
    const running = portText === undefined ? await startOnFreePort(lan) : await startOnPort(Number(portText), lan);
    if (!hubExists(running.store, hubId)) running.store.createHub(hubId, flag(parsed, "title") ?? "", DEFAULT_VIEW_SOURCE);
    writeServerFile(hubId, { address: running.address, pid: process.pid });
    process.once("exit", () => removeServerFile(hubId));

    const includeAllSources = hasFlag(parsed, "all");
    const controller = new AbortController();
    abortOnSignals(controller);
    try {
      const url = `http://${running.address}/h/${hubId}`;
      const port = running.address.split(":")[1];
      const lanUrls = lan ? lanAddresses().map((ip) => `http://${ip}:${port}/h/${hubId}`) : undefined;
      printLine({ hub: hubId, url, view_path: running.store.viewPath(hubId), address: running.address, lan_urls: lanUrls });
      const stream = followEvents({ hubId, sinceSeq: optionalSeq(parsed), signal: controller.signal, address: running.address });
      for await (const event of stream) {
        if (includeAllSources || event.source === USER_SOURCE) printLine(event);
      }
    } finally {
      removeServerFile(hubId);
      await running.close();
    }
  },

  async docs() {
    process.stdout.write(await guideText());
  },

  async ls(args) {
    const parsed = parseArgs(args, ["all"]);
    const hubs = new HubStore(dataDir()).listHubs(hasFlag(parsed, "all"));
    print(hubs.map((hub) => {
      const liveServer = readLiveServer(hub.id);
      return { ...hub, url: liveServer ? `http://${liveServer.address}/h/${hub.id}` : null };
    }));
  },

  async show(args) {
    const { hubId } = resolveHub(parseArgs(args), "show <hub>");
    print({ ...(await api<object>(hubId, "GET", `/hubs/${hubId}`)), url: hubUrl(hubId) });
  },

  async open(args) {
    const { hubId } = resolveHub(parseArgs(args), "open <hub>");
    await api(hubId, "GET", `/hubs/${hubId}`);
    Bun.spawn(["open", hubUrl(hubId)]);
    print({ url: hubUrl(hubId) });
  },

  async close(args) {
    const { hubId } = resolveHub(parseArgs(args), "close <hub>");
    print(await api(hubId, "POST", `/hubs/${hubId}/close`));
  },

  async delete(args) {
    const { hubId } = resolveHub(parseArgs(args), "delete <hub>");
    if (readLiveServer(hubId)) throw new Error(`hub ${hubId} is up; stop its up process first`);
    const store = new HubStore(dataDir());
    store.getHub(hubId);
    store.deleteHub(hubId);
    print({ deleted: hubId });
  },

  async get(args) {
    const { hubId, rest } = resolveHub(parseArgs(args), "get <hub> [path]");
    const state = await api<Record<string, unknown>>(hubId, "GET", `/hubs/${hubId}/state`);
    const [path] = rest;
    if (!path) return print(state);
    const { getPath } = await import("../state/path.ts");
    print(getPath(state, path));
  },

  async patch(args) {
    const usage = "patch <hub> path=value... | --json <json|-|@file>";
    const parsed = parseArgs(args);
    const { hubId, rest } = resolveHub(parsed, usage);
    const jsonArgument = flag(parsed, "json");
    let operations: unknown;
    if (jsonArgument !== undefined) operations = readJsonArgument(jsonArgument);
    else {
      if (rest.length === 0) throw new UsageError(usage);
      operations = rest.map((assignment) => {
        const separator = assignment.indexOf("=");
        if (separator <= 0) throw new UsageError(`"${assignment}" is not path=value`);
        return { path: assignment.slice(0, separator), value: parseValue(assignment.slice(separator + 1)) };
      });
    }
    print(await api(hubId, "PATCH", `/hubs/${hubId}/state`, operations));
  },

  async emit(args) {
    const { hubId, rest } = resolveHub(parseArgs(args), "emit <hub> <type> [json]");
    const [type, payloadText] = rest;
    if (!type) throw new UsageError("emit <hub> <type> [json]");
    const payload = payloadText === undefined ? {} : readJsonArgument(payloadText);
    print(await api(hubId, "POST", `/hubs/${hubId}/events`, { type, payload }));
  },

  async events(args) {
    const parsed = parseArgs(args);
    const { hubId } = resolveHub(parsed, "events <hub> [--since N] [--type T]");
    const query = new URLSearchParams({ since: String(optionalSeq(parsed) ?? 0) });
    const eventType = flag(parsed, "type");
    if (eventType) query.set("type", eventType);
    print(await api(hubId, "GET", `/hubs/${hubId}/events?${query}`));
  },

  async wait(args) {
    const usage = "wait <hub> [--type T] [--match k=v]... [--since N] [--timeout 30m]";
    const parsed = parseArgs(args);
    const { hubId } = resolveHub(parsed, usage);
    const eventType = flag(parsed, "type");
    const matchers = parseMatchers(flagList(parsed, "match"));
    const timeoutText = flag(parsed, "timeout");
    const timeoutMs = timeoutText === undefined ? undefined : parseDuration(timeoutText);
    await api(hubId, "GET", `/hubs/${hubId}`);

    const controller = new AbortController();
    let isTimedOut = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      isTimedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      for await (const event of followEvents({ hubId, sinceSeq: optionalSeq(parsed), signal: controller.signal })) {
        const isTypeMatch = eventType === undefined || event.type === eventType;
        if (isTypeMatch && payloadMatches(event.payload, matchers)) {
          print(event);
          return;
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    if (isTimedOut) {
      print({ timeout: true });
      return EXIT_TIMEOUT;
    }
    throw new Error(`hub ${hubId} closed before a matching event`);
  },
};

async function main(argv: string[]): Promise<number> {
  const [commandName, ...args] = argv;
  if (!commandName || commandName === "help" || commandName === "--help" || commandName === "-h") {
    process.stdout.write(USAGE);
    return commandName ? 0 : EXIT_USAGE;
  }
  const command = commands[commandName];
  if (!command) {
    console.error(`djt-hub: unknown command "${commandName}"\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    return (await command(args)) ?? 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ error: message }));
    return error instanceof UsageError ? EXIT_USAGE : EXIT_ERROR;
  }
}

process.exit(await main(process.argv.slice(2)));
