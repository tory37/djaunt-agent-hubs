import { createServer, type Server, type ServerResponse } from "node:http";
import { createServer as createProbeServer } from "node:net";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import type { ViteDevServer } from "vite";
import { ATTACH_GRACE_MS } from "../config.ts";
import { HubStore } from "../store/store.ts";
import { createApp } from "./app.ts";
import { createAuthGuard } from "./auth.ts";
import { isLocalNetworkAddress, isLoopbackAddress } from "./lan.ts";
import { startViewHost } from "./views.ts";

export type ServeOptions = {
  address: string;
  dataDir: string;
  attachGraceMs?: number;
  withViews?: boolean;
  lan?: boolean;
  password?: string;
};

export type RunningServer = { server: Server; store: HubStore; address: string; close: () => Promise<void> };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const ALL_INTERFACES_HOST = "0.0.0.0";
const API_PREFIX = "/api/";
const FS_PREFIX = "/@fs/";
const PORT_SEARCH_LIMIT = 100;

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

function isPortFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createProbeServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

export function isPortTaken(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EADDRINUSE";
}

export async function findFreePort(host: string, firstPort: number, lan = false): Promise<number> {
  for (let port = firstPort; port < firstPort + PORT_SEARCH_LIMIT; port++) {
    if (await isPortFree(lan ? ALL_INTERFACES_HOST : host, port)) return port;
  }
  throw new Error(`no free port from ${firstPort} to ${firstPort + PORT_SEARCH_LIMIT - 1}`);
}

export async function startServer({
  address,
  dataDir,
  attachGraceMs = ATTACH_GRACE_MS,
  withViews = true,
  lan = false,
  password,
}: ServeOptions): Promise<RunningServer> {
  const [host = "", portText = ""] = address.split(":");
  if (!LOOPBACK_HOSTS.has(host)) throw new Error(`address ${address} must be loopback; hubs are local-only`);

  const store = new HubStore(dataDir);
  const { app } = createApp({ store, attachGraceMs });
  const apiListener = getRequestListener(app.fetch);
  // The machine itself is trusted, so the CLI needs no login; only network peers do.
  const authGuard = lan && password ? createAuthGuard(password) : undefined;
  const needsLogin = (request: { socket: { remoteAddress?: string }; headers: { cookie?: string } }) =>
    authGuard !== undefined &&
    !isLoopbackAddress(request.socket.remoteAddress) &&
    !authGuard.isAuthorized(request as Parameters<typeof authGuard.isAuthorized>[0]);
  let viewHost: ViteDevServer | undefined;

  const server = createServer((request, response) => {
    // Bun's node:http never emits "close" on the response when the client
    // disconnects, so a stream would never see its client go away.
    // Keep-alive sockets outlive each request, so the listener must go too.
    const destroyOnDisconnect = () => {
      if (!response.writableEnded) response.destroy();
    };
    request.socket.once("close", destroyOnDisconnect);
    response.once("finish", () => request.socket.off("close", destroyOnDisconnect));
    if (authGuard !== undefined && needsLogin(request)) return authGuard.respondUnauthorized(request, response);
    const isApiRequest = request.url?.startsWith(API_PREFIX) ?? false;
    if (isApiRequest || viewHost === undefined) return apiListener(request, response);
    const host = viewHost;
    host.middlewares(request, response, () => void respondWithViewError(host, request.url ?? "", response));
  });

  // The socket binds every interface, so only private-range peers may stay.
  if (lan) {
    server.on("connection", (socket) => {
      if (!isLocalNetworkAddress(socket.remoteAddress)) socket.destroy();
    });
  }

  server.prependListener("upgrade", (request, socket) => {
    if (needsLogin(request)) socket.destroy();
  });

  if (withViews) viewHost = await startViewHost(server, store.hubsDir, join(dataDir, "vite-cache", portText));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(Number(portText), lan ? ALL_INTERFACES_HOST : host, resolve);
    });
  } catch (error) {
    await viewHost?.close();
    throw error;
  }
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
