import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticHubProvider, type HubValue } from "../src/sdk/hub-context.tsx";
import { Actions, Checklist, Form, Gate, Grid, Log, Panel, Stats, Steps, Table } from "../src/sdk/index.ts";
import type { JsonObject } from "../src/state/path.ts";

function hubValue(state: JsonObject, canAct: boolean): HubValue {
  return {
    hubId: "demo",
    hub: undefined,
    state,
    events: [{ seq: 1, hub: "demo", source: "user", type: "deploy.started", payload: {}, ts: 1_700_000_000_000 }],
    attached: canAct,
    closed: false,
    canAct,
    connected: true,
    emit: async () => canAct,
    patch: async () => canAct,
    get: () => undefined,
  };
}

function render(node: ReactNode, state: JsonObject = {}, canAct = true): string {
  return renderToStaticMarkup(<StaticHubProvider value={hubValue(state, canAct)}>{node}</StaticHubProvider>);
}

function countDisabled(markup: string): number {
  return (markup.match(/disabled=""/g) ?? []).length;
}

const STEPS_STATE: JsonObject = {
  steps: [
    { id: "build", label: "Build", status: "done", started_at: 100, ended_at: 160 },
    { id: "promote", label: "Promote", status: "waiting", gate: "Promote to prod?" },
    { id: "verify", label: "Verify", status: "skipped" },
  ],
};

describe("Steps", () => {
  test("renders bound steps, elapsed time, and the open gate", () => {
    const markup = render(<Steps id="run" bind="steps" />, STEPS_STATE);
    expect(markup).toContain("Build");
    expect(markup).toContain("1m 00s");
    expect(markup).toContain("Promote to prod?");
    expect(markup).toContain("Approve");
    expect(markup).toContain("line-through");
  });

  test("hides the gate once the step leaves waiting", () => {
    const state = { steps: [{ id: "promote", label: "Promote", status: "running", gate: "Promote to prod?" }] };
    expect(render(<Steps id="run" bind="steps" />, state)).not.toContain("Promote to prod?");
  });
});

describe("controls disable while unattached", () => {
  const cases: [string, ReactNode][] = [
    ["Gate", <Gate id="g" prompt="Go?" />],
    ["Actions", <Actions id="a" items={[{ id: "pause", label: "Pause" }]} />],
    ["Form", <Form id="f" fields={[{ name: "env", kind: "select", options: ["prod"] }]} />],
    ["Checklist", <Checklist id="c" items={[{ id: "x", label: "Backup taken" }]} />],
  ];
  for (const [name, node] of cases) {
    test(name, () => {
      expect(countDisabled(render(node, {}, true))).toBe(0);
      expect(countDisabled(render(node, {}, false))).toBeGreaterThan(0);
    });
  }
});

describe("data views", () => {
  test("Stats takes an object or a list", () => {
    const markup = render(<Stats bind="health" />, { health: { p99: { value: 182, unit: "ms", tone: "ok" }, version: "4.1" } });
    expect(markup).toContain("182");
    expect(markup).toContain("text-ok");
    expect(markup).toContain("4.1");
  });

  test("Table renders columns and status tones", () => {
    const rows = [{ id: "a", name: "api", status: "failed", p99: 120 }];
    const markup = render(<Table rows={rows} columns={["name", { key: "status", kind: "status" }, { key: "p99", kind: "number" }]} />);
    expect(markup).toContain("api");
    expect(markup).toContain("text-bad");
    expect(markup).toContain("text-right");
  });

  test("Log shows hub events by prefix", () => {
    expect(render(<Log events="deploy." />)).toContain("deploy.started");
    expect(render(<Log events="other." />)).toContain("No log lines yet.");
  });

  test("Grid and Panel lay out widths", () => {
    const markup = render(
      <Grid>
        <Panel title="A" width="half" />
        <Panel title="B" width="half" />
      </Grid>,
    );
    expect(markup.match(/md:col-span-6/g)).toHaveLength(2);
  });
});
