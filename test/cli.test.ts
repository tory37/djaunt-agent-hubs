import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, parseDuration } from "../src/cli/args.ts";
import { startServer, type RunningServer } from "../src/server/serve.ts";
import { makeTempDir, sleep } from "./helpers.ts";

const CLI_ENTRY = join(import.meta.dir, "../src/cli/main.ts");
const GRACE_MS = 100;

let tempDir: ReturnType<typeof makeTempDir>;
let running: RunningServer;

function cliEnv(): Record<string, string> {
  return { ...(process.env as Record<string, string>), DJT_HUB_ADDR: running.address, DJT_HUB_ID: "" };
}

async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string; json: any }> {
  const child = Bun.spawn(["bun", CLI_ENTRY, ...args], { env: cliEnv(), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { code, stdout, stderr, json };
}

async function postUserEvent(hubId: string, type: string, payload: unknown) {
  return fetch(`http://${running.address}/api/hubs/${hubId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-source": "user" },
    body: JSON.stringify({ type, payload }),
  });
}

async function waitUntilAttached(hubId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const hub = await (await fetch(`http://${running.address}/api/hubs/${hubId}`)).json();
    if (hub.attached) return;
    await sleep(20);
  }
  throw new Error(`hub ${hubId} never attached`);
}

beforeAll(async () => {
  tempDir = makeTempDir();
  running = await startServer({ address: "127.0.0.1:0", dataDir: tempDir.path, attachGraceMs: GRACE_MS });
});

afterAll(async () => {
  await running.close();
  tempDir.cleanup();
});

describe("args", () => {
  test("flags anywhere, repeatable, and inline values", () => {
    const parsed = parseArgs(["wait", "--match", "a=1", "hub", "--match=b=2", "--all"], ["all"]);
    expect(parsed.positionals).toEqual(["wait", "hub"]);
    expect(parsed.flags.get("match")).toEqual(["a=1", "b=2"]);
    expect(parsed.flags.get("all")).toEqual(["true"]);
  });

  test("durations", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(() => parseDuration("soon")).toThrow("bad duration");
  });
});

describe("cli", () => {
  test("create writes the view file and prints the URL", async () => {
    const result = await cli("create", "alpha", "--title", "Alpha");
    expect(result.code).toBe(0);
    expect(result.json.title).toBe("Alpha");
    expect(result.json.url).toBe(`http://${running.address}/h/alpha`);
    expect(existsSync(result.json.view_path)).toBe(true);
  });

  test("patch and get round-trip", async () => {
    await cli("create", "beta");
    expect((await cli("patch", "beta", "count=3", "label=hello", 'steps=[{"id":"a"}]')).code).toBe(0);
    expect((await cli("get", "beta", "count")).json).toBe(3);
    expect((await cli("get", "beta", "steps.a.id")).json).toBe("a");
    await cli("patch", "beta", "--json", '[{"path":"label","value":null}]');
    expect((await cli("get", "beta")).json).toEqual({ count: 3, steps: [{ id: "a" }] });
  });

  test("unknown hub fails with exit 1", async () => {
    const result = await cli("show", "missing");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not found");
  });

  test("missing hub argument is a usage error", async () => {
    expect((await cli("show")).code).toBe(64);
  });

  test("listen attaches and prints user events as JSON lines", async () => {
    await cli("create", "gamma");
    const listener = Bun.spawn(["bun", CLI_ENTRY, "listen", "gamma"], { env: cliEnv(), stdout: "pipe" });
    await waitUntilAttached("gamma");
    await cli("emit", "gamma", "agent.note");
    expect((await postUserEvent("gamma", "action", { action: "go" })).status).toBe(201);

    const reader = listener.stdout.getReader();
    const { value } = await reader.read();
    const firstLine = new TextDecoder().decode(value).trim().split("\n")[0]!;
    const event = JSON.parse(firstLine);
    expect(event.type).toBe("action");
    expect(event.source).toBe("user");
    listener.kill();
    await listener.exited;
  });

  test("wait returns the matching event", async () => {
    await cli("create", "delta");
    const waiting = cli("wait", "delta", "--match", "step=promote", "--timeout", "5s");
    await waitUntilAttached("delta");
    await postUserEvent("delta", "gate.approve", { block: "run", step: "build" });
    await postUserEvent("delta", "gate.approve", { block: "run", step: "promote" });
    const result = await waiting;
    expect(result.code).toBe(0);
    expect(result.json.payload.step).toBe("promote");
  });

  test("wait exits 2 on timeout", async () => {
    await cli("create", "epsilon");
    const result = await cli("wait", "epsilon", "--timeout", "200ms");
    expect(result.code).toBe(2);
    expect(result.json).toEqual({ timeout: true });
  });

  test("listen releases the attach after it exits", async () => {
    await cli("create", "zeta");
    const listener = Bun.spawn(["bun", CLI_ENTRY, "listen", "zeta"], { env: cliEnv(), stdout: "pipe" });
    await waitUntilAttached("zeta");
    listener.kill();
    await listener.exited;
    await sleep(GRACE_MS * 3);
    const hub = await (await fetch(`http://${running.address}/api/hubs/zeta`)).json();
    expect(hub.attached).toBe(false);
  });
});
