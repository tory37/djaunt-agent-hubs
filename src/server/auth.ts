import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE_NAME = "djt_hub_auth";
const LOGIN_PATH = "/__login";
const FAILED_LOGIN_DELAY_MS = 1_000;
const MAX_LOGIN_BODY_BYTES = 4_096;

export type AuthGuard = {
  isAuthorized: (request: IncomingMessage) => boolean;
  respondUnauthorized: (request: IncomingMessage, response: ServerResponse) => void;
};

function loginPage(wrongPassword: boolean, next: string): string {
  const escapedNext = next.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hub login</title>
<style>body{font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#111;color:#eee}
form{display:grid;gap:12px;width:min(320px,90vw)}input,button{font:inherit;padding:10px;border-radius:6px;border:1px solid #444;background:#1c1c1c;color:inherit}
button{background:#3b82f6;border-color:#3b82f6;cursor:pointer}p{color:#f87171;margin:0}</style>
<form method="post" action="${LOGIN_PATH}"><input type="hidden" name="next" value="${escapedNext}">
${wrongPassword ? "<p>Wrong password.</p>" : ""}
<input type="password" name="password" placeholder="Password" autofocus required><button>Log in</button></form>`;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > MAX_LOGIN_BODY_BYTES) request.destroy();
    });
    request.on("end", () => resolve(body));
    request.on("error", () => resolve(""));
  });
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of (header ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator > 0) cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
  }
  return cookies;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

// Only same-origin relative paths may follow a login, so the form cannot bounce to another site.
function safeNext(next: string | null): string {
  return next !== null && /^\/(?![/\\])/.test(next) ? next : "/";
}

export function createAuthGuard(password: string): AuthGuard {
  const secret = randomBytes(32);
  const sessionToken = createHmac("sha256", secret).update("session").digest("hex");

  const isAuthorized = (request: IncomingMessage) => {
    const presented = parseCookies(request.headers.cookie).get(COOKIE_NAME);
    return presented !== undefined && safeEqual(presented, sessionToken);
  };

  const sendLoginPage = (response: ServerResponse, wrongPassword: boolean, next: string) => {
    response.statusCode = 401;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(loginPage(wrongPassword, next));
  };

  const handleLogin = async (request: IncomingMessage, response: ServerResponse) => {
    const form = new URLSearchParams(await readBody(request));
    const next = safeNext(form.get("next"));
    if (!safeEqual(form.get("password") ?? "", password)) {
      await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
      sendLoginPage(response, true, next);
      return;
    }
    response.statusCode = 303;
    response.setHeader("set-cookie", `${COOKIE_NAME}=${sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
    response.setHeader("location", next);
    response.end();
  };

  const respondUnauthorized = (request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? "/";
    if (request.method === "POST" && url === LOGIN_PATH) {
      void handleLogin(request, response);
      return;
    }
    if (url.startsWith("/api/")) {
      response.statusCode = 401;
      response.end("login required");
      return;
    }
    sendLoginPage(response, false, safeNext(url));
  };

  return { isAuthorized, respondUnauthorized };
}
