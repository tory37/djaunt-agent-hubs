import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { startServer, type RunningServer } from "../src/server/serve.ts";
import { makeTempDir } from "./helpers.ts";

let tempDir: ReturnType<typeof makeTempDir>;
let running: RunningServer;

function url(path: string): string {
  return `http://${running.address}${path}`;
}

beforeAll(async () => {
  tempDir = makeTempDir();
  running = await startServer({ address: "127.0.0.1:0", dataDir: tempDir.path });
  await fetch(url("/api/hubs"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "view-demo" }),
  });
});

afterAll(async () => {
  await running.close();
  tempDir.cleanup();
});

describe("view host", () => {
  test("serves the shell for a hub route", async () => {
    const response = await fetch(url("/h/view-demo"));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });

  test("compiles the hub's view.tsx with the SDK alias", async () => {
    const viewPath = running.store.viewPath("view-demo");
    const response = await fetch(url(`/@fs${viewPath}`));
    expect(response.status).toBe(200);
    const compiled = await response.text();
    expect(compiled).toContain("src/sdk/index.ts");
    expect(compiled).toContain("jsxDEV");
  });

  test("returns the compiler message for a broken view", async () => {
    const viewPath = running.store.viewPath("view-demo");
    writeFileSync(viewPath, "export default function View() { return <div>\n");
    const response = await fetch(url(`/@fs${viewPath}?t=broken`));
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("view.tsx");
  });

  test("rebuilds the stylesheet with classes from a hub created after it compiled", async () => {
    await fetch(url("/styles.css"));
    await fetch(url("/api/hubs"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "late-hub" }),
    });
    const lateClass = ["mt", "97"].join("-");
    writeFileSync(running.store.viewPath("late-hub"), `export default function View() { return <div className="${lateClass}" />; }\n`);
    let stylesheet = "";
    for (let attempt = 0; attempt < 50 && !stylesheet.includes(`.${lateClass}`); attempt++) {
      await Bun.sleep(100);
      stylesheet = await (await fetch(url("/styles.css"))).text();
    }
    expect(stylesheet).toContain(`.${lateClass}`);
  });

  test("keeps one close listener on a reused connection", async () => {
    const closeListenerCounts: number[] = [];
    const recordCount = (request: IncomingMessage) => closeListenerCounts.push(request.socket.listenerCount("close"));
    running.server.on("request", recordCount);
    for (let request = 0; request < 15; request++) await (await fetch(url("/api/status"))).text();
    running.server.off("request", recordCount);
    expect(Math.max(...closeListenerCounts)).toBeLessThan(5);
  });

  test("API routes still answer", async () => {
    const response = await fetch(url("/api/status"));
    expect((await response.json()).ok).toBe(true);
  });
});
