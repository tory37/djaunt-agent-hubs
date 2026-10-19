import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { ATTACH_GRACE_MS } from "../config.ts";
import { HubStore } from "../store/store.ts";
import { createApp } from "./app.ts";

export type ServeOptions = { address: string; dataDir: string; attachGraceMs?: number };

export type RunningServer = { server: Server; store: HubStore; address: string; close: () => Promise<void> };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export async function startServer({ address, dataDir, attachGraceMs = ATTACH_GRACE_MS }: ServeOptions): Promise<RunningServer> {
  const [host = "", portText = ""] = address.split(":");
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`address ${address} must be loopback; hubs are local-only`);

  const store = new HubStore(dataDir);
  const { app } = createApp({ store, attachGraceMs });
  const apiListener = getRequestListener(app.fetch);
  const server = createServer((request, response) => {
    // Bun's node:http never emits "close" on the response when the client
    // disconnects, so a stream would never see its client go away.
    request.socket.once("close", () => {
      if (!response.writableEnded) response.destroy();
    });
    return apiListener(request, response);
  });

  await new Promise<void>((resolve) => server.listen(Number(portText), host, resolve));
  const boundPort = (server.address() as { port: number }).port;
  return {
    server,
    store,
    address: `${host}:${boundPort}`,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}
