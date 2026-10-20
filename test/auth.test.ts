import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { createAuthGuard } from "../src/server/auth.ts";

const PASSWORD = "correct horse";
let server: Server;
let base: string;

beforeEach(async () => {
  const guard = createAuthGuard(PASSWORD);
  server = createServer((request, response) => {
    if (!guard.isAuthorized(request)) return guard.respondUnauthorized(request, response);
    response.end("secret page");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(() => server.close());

function login(password: string, next = "/h/demo") {
  return fetch(`${base}/__login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password, next }),
  });
}

describe("auth guard", () => {
  test("shows the login page without a cookie", async () => {
    const response = await fetch(`${base}/h/demo`);
    expect(response.status).toBe(401);
    expect(await response.text()).toContain('name="password"');
  });

  test("api paths get a bare 401", async () => {
    const response = await fetch(`${base}/api/hubs`);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("login required");
  });

  test("a wrong password stays on the login page", async () => {
    const response = await login("nope");
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).toContain("Wrong password");
  });

  test("the right password sets a cookie that opens the page", async () => {
    const response = await login(PASSWORD);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/h/demo");
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const page = await fetch(`${base}/h/demo`, { headers: { cookie } });
    expect(await page.text()).toBe("secret page");
  });

  test("a forged cookie is refused", async () => {
    const page = await fetch(`${base}/h/demo`, { headers: { cookie: "djt_hub_auth=abc" } });
    expect(page.status).toBe(401);
  });

  test("login never redirects off site", async () => {
    const response = await login(PASSWORD, "//evil.example");
    expect(response.headers.get("location")).toBe("/");
  });
});
