import { describe, expect, test } from "bun:test";
import { isLocalNetworkAddress } from "../src/server/lan.ts";

describe("isLocalNetworkAddress", () => {
  test.each(["127.0.0.1", "10.1.2.3", "172.16.0.5", "172.31.255.1", "192.168.1.238", "169.254.1.1", "::ffff:192.168.1.5", "::1", "fe80::1", "fd12::1"])(
    "allows %s",
    (address) => expect(isLocalNetworkAddress(address)).toBe(true),
  );

  test.each(["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.1.1", "11.0.0.1", "::ffff:8.8.8.8", "2001:db8::1", "", "not-an-ip"])(
    "rejects %s",
    (address) => expect(isLocalNetworkAddress(address)).toBe(false),
  );

  test("rejects a missing address", () => expect(isLocalNetworkAddress(undefined)).toBe(false));
});
