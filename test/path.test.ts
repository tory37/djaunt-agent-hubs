import { describe, expect, test } from "bun:test";
import { parseMatchers, payloadMatches } from "../src/state/match.ts";
import { getPath, PathNotFoundError, setPath, type JsonObject } from "../src/state/path.ts";

function sampleState(): JsonObject {
  return {
    title: "Release",
    steps: [
      { id: "build", status: "done" },
      { id: "promote", status: "waiting" },
    ],
  };
}

describe("getPath", () => {
  test("reads nested keys, array indexes, and element ids", () => {
    const state = sampleState();
    expect(getPath(state, "title")).toBe("Release");
    expect(getPath(state, "steps.0.status")).toBe("done");
    expect(getPath(state, "steps.promote.status")).toBe("waiting");
  });

  test("throws PathNotFoundError for a missing path", () => {
    expect(() => getPath(sampleState(), "steps.deploy")).toThrow(PathNotFoundError);
    expect(() => getPath(sampleState(), "missing.key")).toThrow(PathNotFoundError);
  });

  test("rejects empty paths and empty segments", () => {
    expect(() => getPath(sampleState(), "")).toThrow("empty path");
    expect(() => getPath(sampleState(), "steps..status")).toThrow("empty segment");
  });
});

describe("setPath", () => {
  test("creates intermediate objects", () => {
    const state: JsonObject = {};
    setPath(state, "health.p99.value", 120);
    expect(state).toEqual({ health: { p99: { value: 120 } } });
  });

  test("writes into an array element by id", () => {
    const state = sampleState();
    setPath(state, "steps.promote.status", "running");
    expect(getPath(state, "steps.1.status")).toBe("running");
  });

  test("null deletes a key", () => {
    const state = sampleState();
    setPath(state, "title", null);
    expect("title" in state).toBe(false);
  });

  test("null removes an array element", () => {
    const state = sampleState();
    setPath(state, "steps.build", null);
    expect(getPath(state, "steps")).toEqual([{ id: "promote", status: "waiting" }]);
  });

  test("throws for an unknown array element", () => {
    expect(() => setPath(sampleState(), "steps.deploy.status", "x")).toThrow(PathNotFoundError);
  });

  test("throws when descending into a scalar", () => {
    expect(() => setPath(sampleState(), "title.sub", 1)).toThrow("not an object or array");
  });
});

describe("payloadMatches", () => {
  test("matches dotted keys as strings", () => {
    const payload = { block: "run", values: { env: "prod", count: 3 } };
    expect(payloadMatches(payload, parseMatchers(["block=run", "values.env=prod"]))).toBe(true);
    expect(payloadMatches(payload, parseMatchers(["values.count=3"]))).toBe(true);
    expect(payloadMatches(payload, parseMatchers(["block=other"]))).toBe(false);
    expect(payloadMatches(payload, parseMatchers(["missing=1"]))).toBe(false);
  });

  test("no matchers match anything", () => {
    expect(payloadMatches({}, [])).toBe(true);
  });

  test("rejects a matcher without a key", () => {
    expect(() => parseMatchers(["=x"])).toThrow("key=value");
    expect(() => parseMatchers(["novalue"])).toThrow("key=value");
  });
});
