#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { daemonAddress, dataDir } from "../config.ts";
import { parseMatchers, payloadMatches } from "../state/match.ts";
import type { HubEvent } from "../store/store.ts";
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
import { agentStream, api, ApiError, hubUrl } from "./client.ts";

const EXIT_ERROR = 1;
const EXIT_TIMEOUT = 2;
const EXIT_USAGE = 64;
const RECONNECT_DELAY_MS = 1_000;
const USER_SOURCE = "user";

const USAGE = `djt-hub — live local pages that an agent builds and attaches to

Daemon
  serve                                run the daemon (launchd runs this)
  status                               exit 0 if the daemon answers
  install | uninstall                  run the daemon under launchd (macOS)
  docs                                 print the agent guide

Hubs
  create <hub> [--title T]             new hub; prints its URL and view file
  ls [--all]                           list hubs (--all includes closed)
  show <hub>                           hub, state, attached, last event seq
  open <hub>                           open the hub in the browser
  close <hub>                          close the hub; it stays readable
  delete <hub>                         remove a hub and all its files

State
  patch <hub> path=value...            values parse as JSON, else string
  patch <hub> --json <json|-|@file>    [{"path":"a.b","value":1}, ...]
  get <hub> [path]                     print state, or one value

Events
  listen <hub> [--since N] [--all]     attach; print each user event as a JSON line
  wait <hub> [--type T] [--match k=v]... [--since N] [--timeout 30m]
                                       attach until one matching event; exit 2 on timeout
  emit <hub> <type> [json]             append an agent event
  events <hub> [--since N] [--type T]  print event history

Hub resolution: --hub, then $DJT_HUB_ID, then the first argument.
Daemon address: $DJT_HUB_ADDR (default 127.0.0.1:7717).
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

type FollowOptions = { hubId: string; sinceSeq?: number; signal: AbortSignal };

// Streams events and reconnects across daemon restarts, resuming after the
// last seen seq. Ends when the hub closes or the signal aborts.
async function* followEvents({ hubId, sinceSeq, signal }: FollowOptions): AsyncGenerator<HubEvent> {
  let lastSeenSeq = sinceSeq;
  while (!signal.aborted) {
    try {
      for await (const frame of agentStream(hubId, lastSeenSeq, signal)) {
        if (frame.event === "init" && lastSeenSeq === undefined) lastSeenSeq = frame.data.last_seq;
        if (frame.event === "hub" && frame.data.hub.closed_at !== null) return;
        if (frame.event === "event") {
          lastSeenSeq = frame.data.event.seq;
          yield frame.data.event as HubEvent;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiError) throw error;
    }
    await sleep(RECONNECT_DELAY_MS);
  }
}

function optionalSeq(parsed: ParsedArgs): number | undefined {
  const sinceText = flag(parsed, "since");
  return sinceText === undefined ? undefined : Number(sinceText);
}

async function guideText(): Promise<string> {
  return readFileSync(new URL("../../docs/agent-guide.md", import.meta.url), "utf8");
}

const commands: Record<string, (args: string[]) => Promise<number | void>> = {
  async serve() {
    const { startServer } = await import("../server/serve.ts");
    const running = await startServer({ address: daemonAddress(), dataDir: dataDir() });
    console.error(`djt-hub listening on http://${running.address} (hubs in ${running.store.hubsDir})`);
    await new Promise(() => {});
  },

  async status() {
    print(await api("GET", "/status"));
  },

  async docs() {
    process.stdout.write(await guideText());
  },

  async create(args) {
    const parsed = parseArgs(args);
    const { hubId } = resolveHub(parsed, "create <hub> [--title T]");
    const hub = await api("POST", "/hubs", { id: hubId, title: flag(parsed, "title") });
    print({ ...(hub as object), url: hubUrl(hubId) });
  },

  async ls(args) {
    const parsed = parseArgs(args, ["all"]);
    print(await api("GET", hasFlag(parsed, "all") ? "/hubs?all" : "/hubs"));
  },

  async show(args) {
    const { hubId } = resolveHub(parseArgs(args), "show <hub>");
    print({ ...(await api<object>("GET", `/hubs/${hubId}`)), url: hubUrl(hubId) });
  },

  async open(args) {
    const { hubId } = resolveHub(parseArgs(args), "open <hub>");
    await api("GET", `/hubs/${hubId}`);
    Bun.spawn(["open", hubUrl(hubId)]);
    print({ url: hubUrl(hubId) });
  },

  async close(args) {
    const { hubId } = resolveHub(parseArgs(args), "close <hub>");
    print(await api("POST", `/hubs/${hubId}/close`));
  },

  async delete(args) {
    const { hubId } = resolveHub(parseArgs(args), "delete <hub>");
    print(await api("DELETE", `/hubs/${hubId}`));
  },

  async get(args) {
    const { hubId, rest } = resolveHub(parseArgs(args), "get <hub> [path]");
    const state = await api<Record<string, unknown>>("GET", `/hubs/${hubId}/state`);
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
    print(await api("PATCH", `/hubs/${hubId}/state`, operations));
  },

  async emit(args) {
    const { hubId, rest } = resolveHub(parseArgs(args), "emit <hub> <type> [json]");
    const [type, payloadText] = rest;
    if (!type) throw new UsageError("emit <hub> <type> [json]");
    const payload = payloadText === undefined ? {} : readJsonArgument(payloadText);
    print(await api("POST", `/hubs/${hubId}/events`, { type, payload }));
  },

  async events(args) {
    const parsed = parseArgs(args);
    const { hubId } = resolveHub(parsed, "events <hub> [--since N] [--type T]");
    const query = new URLSearchParams({ since: String(optionalSeq(parsed) ?? 0) });
    const eventType = flag(parsed, "type");
    if (eventType) query.set("type", eventType);
    print(await api("GET", `/hubs/${hubId}/events?${query}`));
  },

  async listen(args) {
    const parsed = parseArgs(args, ["all"]);
    const { hubId } = resolveHub(parsed, "listen <hub> [--since N] [--all]");
    await api("GET", `/hubs/${hubId}`);
    const includeAllSources = hasFlag(parsed, "all");
    const controller = new AbortController();
    process.on("SIGINT", () => controller.abort());
    process.on("SIGTERM", () => controller.abort());
    for await (const event of followEvents({ hubId, sinceSeq: optionalSeq(parsed), signal: controller.signal })) {
      if (includeAllSources || event.source === USER_SOURCE) printLine(event);
    }
  },

  async wait(args) {
    const usage = "wait <hub> [--type T] [--match k=v]... [--since N] [--timeout 30m]";
    const parsed = parseArgs(args);
    const { hubId } = resolveHub(parsed, usage);
    const eventType = flag(parsed, "type");
    const matchers = parseMatchers(flagList(parsed, "match"));
    const timeoutText = flag(parsed, "timeout");
    const timeoutMs = timeoutText === undefined ? undefined : parseDuration(timeoutText);
    await api("GET", `/hubs/${hubId}`);

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
  if (commandName === "install" || commandName === "uninstall") {
    const { runLaunchdCommand } = await import("./launchd.ts");
    return runLaunchdCommand(commandName);
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
