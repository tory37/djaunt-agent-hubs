import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, parseDuration } from "../src/cli/args.ts";
import { makeTempDir, sleep } from "./helpers.ts";

const CLI_ENTRY = join(import.meta.dir, "../src/cli/main.ts");
const DEAD_PID = 2 ** 22 + 1;

let tempDir: ReturnType<typeof makeTempDir>;
const upProcesses: Bun.Subprocess[] = [];

function cliEnv(): Record<string, string> {
  return { ...(process.env as Record<string, string>), DJT_HUB_DATA: tempDir.path, DJT_HUB_VIEWS: "off", DJT_HUB_ID: "", DJT_HUB_ADDR: "" };
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

type UpProcess = { child: Bun.Subprocess<"ignore", "pipe", "pipe">; first: any; nextLine: () => Promise<any> };

// Starts `up` and reads its first line. nextLine reads each later JSON line.
async function up(...args: string[]): Promise<UpProcess> {
  const child = Bun.spawn(["bun", CLI_ENTRY, "up", ...args], { env: cliEnv(), stdout: "pipe", stderr: "pipe" });
  upProcesses.push(child);
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function nextLine(): Promise<any> {
    while (!buffer.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`up exited: ${await new Response(child.stderr).text()}`);
      buffer += decoder.decode(value, { stream: true });
    }
    const lineEnd = buffer.indexOf("\n");
    const line = buffer.slice(0, lineEnd);
    buffer = buffer.slice(lineEnd + 1);
    return JSON.parse(line);
  }
  return { child, first: await nextLine(), nextLine };
}

async function stop(upProcess: UpProcess): Promise<void> {
  upProcess.child.kill();
  await upProcess.child.exited;
}

function postUserEvent(address: string, hubId: string, type: string, payload: unknown) {
  return fetch(`http://${address}/api/hubs/${hubId}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-source": "user" },
    body: JSON.stringify({ type, payload }),
  });
}

function serverFile(hubId: string): string {
  return join(tempDir.path, "hubs", hubId, "server.json");
}

beforeAll(() => {
  tempDir = makeTempDir();
});

afterAll(async () => {
  for (const child of upProcesses) child.kill();
  await Promise.all(upProcesses.map((child) => child.exited));
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

describe("up", () => {
  test("prints the URL and view file, and records its server", async () => {
    const alpha = await up("alpha", "--title", "Alpha", "--port", "0");
    expect(alpha.first.hub).toBe("alpha");
    expect(alpha.first.url).toBe(`http://${alpha.first.address}/h/alpha`);
    expect(existsSync(alpha.first.view_path)).toBe(true);
    expect(existsSync(serverFile("alpha"))).toBe(true);
    expect((await cli("show", "alpha")).json.title).toBe("Alpha");
    await stop(alpha);
  });

  test("other commands reach the up server", async () => {
    const beta = await up("beta", "--port", "0");
    expect((await cli("patch", "beta", "count=3", "label=hello", 'steps=[{"id":"a"}]')).code).toBe(0);
    expect((await cli("get", "beta", "count")).json).toBe(3);
    expect((await cli("get", "beta", "steps.a.id")).json).toBe("a");
    await cli("patch", "beta", "--json", '[{"path":"label","value":null}]');
    expect((await cli("get", "beta")).json).toEqual({ count: 3, steps: [{ id: "a" }] });
    await stop(beta);
  });

  test("prints each user event as a JSON line, and skips agent events", async () => {
    const gamma = await up("gamma", "--port", "0");
    await cli("emit", "gamma", "agent.note");
    expect((await postUserEvent(gamma.first.address, "gamma", "action", { action: "go" })).status).toBe(201);
    const event = await gamma.nextLine();
    expect(event.type).toBe("action");
    expect(event.source).toBe("user");
    await stop(gamma);
  });

  test("two hubs come up on two ports", async () => {
    const [left, right] = await Promise.all([up("left"), up("right")]);
    expect(left.first.address).not.toBe(right.first.address);
    await Promise.all([stop(left), stop(right)]);
  });

  test("exits 1 when the pinned port is taken", async () => {
    const holder = await up("holder", "--port", "0");
    const port = holder.first.address.split(":")[1];
    const second = await cli("up", "pinned", "--port", port);
    expect(second.code).toBe(1);
    await stop(holder);
  });

  test("refuses a hub that is already up", async () => {
    const delta = await up("delta", "--port", "0");
    const second = await cli("up", "delta", "--port", "0");
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("already up");
    await stop(delta);
  });

  test("stopping up takes the server down", async () => {
    const epsilon = await up("epsilon", "--port", "0");
    await stop(epsilon);
    expect(existsSync(serverFile("epsilon"))).toBe(false);
    expect(fetch(`http://${epsilon.first.address}/api/status`)).rejects.toThrow();
    const result = await cli("get", "epsilon");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("djt-hub up epsilon");
  });

  test("close ends the up process", async () => {
    const zeta = await up("zeta", "--port", "0");
    expect((await cli("close", "zeta")).code).toBe(0);
    expect(await zeta.child.exited).toBe(0);
  });
});

describe("hub commands", () => {
  test("a server file with a dead pid reads as not up", async () => {
    const eta = await up("eta", "--port", "0");
    await stop(eta);
    writeFileSync(serverFile("eta"), JSON.stringify({ address: eta.first.address, pid: DEAD_PID }));
    const result = await cli("patch", "eta", "a=1");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("is not up");
  });

  test("ls and delete work with no server, and delete refuses a hub that is up", async () => {
    const theta = await up("theta", "--port", "0");
    const listed = (await cli("ls")).json as { id: string; url: string | null }[];
    expect(listed.find((hub) => hub.id === "theta")?.url).toBe(theta.first.url);
    expect(listed.find((hub) => hub.id === "beta")?.url).toBeNull();
    expect((await cli("delete", "theta")).code).toBe(1);
    await stop(theta);
    expect((await cli("delete", "theta")).json).toEqual({ deleted: "theta" });
    expect((await cli("ls")).json.some((hub: { id: string }) => hub.id === "theta")).toBe(false);
  });

  test("missing hub argument is a usage error", async () => {
    expect((await cli("show")).code).toBe(64);
  });

  test("help lists up and none of the daemon commands", async () => {
    const help = (await cli("help")).stdout;
    expect(help).toContain("up <hub>");
    expect(help).not.toMatch(/^ {2}(serve|status|install|uninstall|listen|create)\b/m);
  });
});

describe("wait", () => {
  test("returns the matching event", async () => {
    const iota = await up("iota", "--port", "0");
    const waiting = cli("wait", "iota", "--match", "step=promote", "--timeout", "5s");
    await sleep(300);
    await postUserEvent(iota.first.address, "iota", "gate.approve", { block: "run", step: "build" });
    await postUserEvent(iota.first.address, "iota", "gate.approve", { block: "run", step: "promote" });
    const result = await waiting;
    expect(result.code).toBe(0);
    expect(result.json.payload.step).toBe("promote");
    await stop(iota);
  });

  test("exits 2 on timeout", async () => {
    const kappa = await up("kappa", "--port", "0");
    const result = await cli("wait", "kappa", "--timeout", "200ms");
    expect(result.code).toBe(2);
    expect(result.json).toEqual({ timeout: true });
    await stop(kappa);
  });
});
