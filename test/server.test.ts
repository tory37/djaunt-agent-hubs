import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createApp } from "../src/server/app.ts";
import { HubStore } from "../src/store/store.ts";
import { makeTempDir, readSse, sleep } from "./helpers.ts";

const GRACE_MS = 80;

let tempDir: ReturnType<typeof makeTempDir>;
let store: HubStore;
let app: ReturnType<typeof createApp>["app"];
let attach: ReturnType<typeof createApp>["attach"];

function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return app.request(`/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function postUserEvent(hubId: string, type = "action") {
  return request("POST", `/hubs/${hubId}/events`, { type, payload: { action: "go" } }, { "x-hub-source": "user" });
}

beforeEach(async () => {
  tempDir = makeTempDir();
  store = new HubStore(tempDir.path);
  ({ app, attach } = createApp({ store, attachGraceMs: GRACE_MS }));
  await request("POST", "/hubs", { id: "demo", title: "Demo" });
});

afterEach(() => tempDir.cleanup());

describe("store", () => {
  test("create writes the hub folder with a view file", () => {
    expect(existsSync(store.viewPath("demo"))).toBe(true);
    expect(readFileSync(store.viewPath("demo"), "utf8")).toContain("useHub");
  });

  test("a patch persists across a store reload", async () => {
    await request("PATCH", "/hubs/demo/state", [{ path: "steps", value: [{ id: "a", status: "done" }] }]);
    const reloaded = new HubStore(tempDir.path);
    expect(reloaded.getState("demo")).toEqual({ steps: [{ id: "a", status: "done" }] });
  });

  test("a bad patch leaves state untouched", async () => {
    await request("PATCH", "/hubs/demo/state", [{ path: "count", value: 1 }]);
    const response = await request("PATCH", "/hubs/demo/state", [
      { path: "count", value: 2 },
      { path: "count.nested", value: 3 },
    ]);
    expect(response.status).toBe(400);
    expect(store.getState("demo")).toEqual({ count: 1 });
  });

  test("event seq increases and survives a restart", async () => {
    await request("POST", "/hubs/demo/events", { type: "note" });
    await request("POST", "/hubs/demo/events", { type: "note" });
    const reloaded = new HubStore(tempDir.path);
    expect(reloaded.appendEvent("demo", "agent", "note", {}).seq).toBe(3);
  });

  test("rejects a bad hub id and a duplicate", async () => {
    expect((await request("POST", "/hubs", { id: "Bad Id" })).status).toBe(400);
    expect((await request("POST", "/hubs", { id: "demo" })).status).toBe(409);
    expect((await request("GET", "/hubs/missing")).status).toBe(404);
  });
});

describe("attach", () => {
  test("a user event on an unattached hub returns 409", async () => {
    const response = await postUserEvent("demo");
    expect(response.status).toBe(409);
    expect(store.listEvents("demo")).toHaveLength(0);
  });

  test("an agent stream attaches, holds through grace, then clears", async () => {
    const controller = new AbortController();
    const stream = await app.request("/api/hubs/demo/stream", {
      headers: { "x-hub-agent": "1" },
      signal: controller.signal,
    });
    const [init] = await readSse(stream, 1);
    expect(init!.data.attached).toBe(true);
    expect(attach.isAttached("demo")).toBe(true);
    expect((await postUserEvent("demo")).status).toBe(201);

    await stream.body!.cancel();
    controller.abort();
    await sleep(GRACE_MS / 4);
    expect(attach.isAttached("demo")).toBe(true);
    await sleep(GRACE_MS * 2);
    expect(attach.isAttached("demo")).toBe(false);
    expect((await postUserEvent("demo")).status).toBe(409);
  });

  test("a browser stream does not attach", async () => {
    const controller = new AbortController();
    const stream = await app.request("/api/hubs/demo/stream", { signal: controller.signal });
    const [init] = await readSse(stream, 1);
    expect(init!.data.attached).toBe(false);
    controller.abort();
  });

  test("agents may write while unattached", async () => {
    expect((await request("POST", "/hubs/demo/events", { type: "note" })).status).toBe(201);
    expect((await request("PATCH", "/hubs/demo/state", [{ path: "a", value: 1 }])).status).toBe(200);
  });

  test("a closed hub rejects writes", async () => {
    await request("POST", "/hubs/demo/close");
    expect((await request("PATCH", "/hubs/demo/state", [{ path: "a", value: 1 }])).status).toBe(409);
  });
});

describe("stream", () => {
  test("delivers init, attach change, a patch, and an event", async () => {
    const controller = new AbortController();
    const browserStream = await app.request("/api/hubs/demo/stream", { signal: controller.signal });
    const agentController = new AbortController();
    const agentStreamPromise = sleep(10).then(() =>
      app.request("/api/hubs/demo/stream", { headers: { "x-hub-agent": "1" }, signal: agentController.signal }),
    );
    const messagesPromise = readSse(browserStream, 4);
    const agentStream = await agentStreamPromise;
    await readSse(agentStream, 1);
    await request("PATCH", "/hubs/demo/state", [{ path: "count", value: 5 }]);
    await postUserEvent("demo");

    const messages = await messagesPromise;
    expect(messages.map((message) => message.event)).toEqual(["init", "attach", "state", "event"]);
    expect(messages[2]!.data.state).toEqual({ count: 5 });
    expect(messages[3]!.data.event.source).toBe("user");
    controller.abort();
    agentController.abort();
  });

  test("replays events after since", async () => {
    await request("POST", "/hubs/demo/events", { type: "first" });
    await request("POST", "/hubs/demo/events", { type: "second" });
    const controller = new AbortController();
    const stream = await app.request("/api/hubs/demo/stream?since=1", { signal: controller.signal });
    const messages = await readSse(stream, 2);
    expect(messages[1]!.data.event.type).toBe("second");
    controller.abort();
  });
});
