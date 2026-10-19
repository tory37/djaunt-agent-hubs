import { createServer, type Server, type ServerResponse } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { ViteDevServer } from "vite";
import { ATTACH_GRACE_MS } from "../config.ts";
import { HubStore } from "../store/store.ts";
import { createApp } from "./app.ts";
import { startViewHost } from "./views.ts";

export type ServeOptions = { address: string; dataDir: string; attachGraceMs?: number; withViews?: boolean };

export type RunningServer = { server: Server; store: HubStore; address: string; close: () => Promise<void> };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const API_PREFIX = "/api/";
const FS_PREFIX = "/@fs/";

type ViteError = Error & { id?: string; frame?: string; loc?: { line: number; column: number } };

function describeViewError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const viteError = error as ViteError;
  const location = viteError.loc ? `${viteError.id ?? ""}:${viteError.loc.line}:${viteError.loc.column}` : viteError.id;
  return [viteError.message, location, viteError.frame].filter(Boolean).join("\n\n");
}

// In middleware mode Vite logs a failed transform and falls through with no
// error, so rerun the transform to recover the compiler message for the page.
async function respondWithViewError(viewHost: ViteDevServer, url: string, response: ServerResponse): Promise<void> {
  response.setHeader("content-type", "text/plain; charset=utf-8");
  if (!url.startsWith(FS_PREFIX)) {
    response.statusCode = 404;
    response.end("Not found");
    return;
  }
  try {
    await viewHost.transformRequest(url);
    response.statusCode = 404;
    response.end("Not found");
  } catch (error) {
    response.statusCode = 500;
    response.end(describeViewError(error));
  }
}

export async function startServer({
  address,
  dataDir,
  attachGraceMs = ATTACH_GRACE_MS,
  withViews = true,
}: ServeOptions): Promise<RunningServer> {
  const [host = "", portText = ""] = address.split(":");
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`address ${address} must be loopback; hubs are local-only`);

  const store = new HubStore(dataDir);
  const { app } = createApp({ store, attachGraceMs });
  const apiListener = getRequestListener(app.fetch);
  let viewHost: ViteDevServer | undefined;

  const server = createServer((request, response) => {
    // Bun's node:http never emits "close" on the response when the client
    // disconnects, so a stream would never see its client go away.
    request.socket.once("close", () => {
      if (!response.writableEnded) response.destroy();
    });
    const isApiRequest = request.url?.startsWith(API_PREFIX) ?? false;
    if (isApiRequest || viewHost === undefined) return apiListener(request, response);
    const host = viewHost;
    host.middlewares(request, response, () => void respondWithViewError(host, request.url ?? "", response));
  });

  if (withViews) viewHost = await startViewHost(server, store.hubsDir);
  await new Promise<void>((resolve) => server.listen(Number(portText), host, resolve));
  const boundPort = (server.address() as { port: number }).port;
  return {
    server,
    store,
    address: `${host}:${boundPort}`,
    close: async () => {
      await viewHost?.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
