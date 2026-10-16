import assert from "node:assert/strict";
import { test } from "node:test";
import { agentStatus, chartSeries, daemonAgents, formatDuration, getPath, renderMarkdown, statTiles, toMillis } from "../static/lib.js";

test("getPath resolves array elements by index or id", () => {
  const state = { release: { steps: [{ id: "tag", status: "done" }, { id: "deploy", status: "running" }] } };
  assert.equal(getPath(state, "release.steps.deploy.status"), "running");
  assert.equal(getPath(state, "release.steps.0.id"), "tag");
  assert.equal(getPath(state, "release.missing.x"), undefined);
  assert.equal(getPath(state, ""), state);
});

test("renderMarkdown escapes HTML before adding markup", () => {
  const html = renderMarkdown("# Title\n\n<script>x</script> **bold** `a<b`\n\n- one\n- two");
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>a&lt;b<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});

test("renderMarkdown drops unsafe link schemes", () => {
  assert.doesNotMatch(renderMarkdown("[x](javascript:alert(1))"), /href/);
  assert.match(renderMarkdown("[ci](https://ci.example/run/1)"), /href="https:\/\/ci.example\/run\/1"/);
});

test("renderMarkdown keeps snake_case identifiers intact", () => {
  assert.doesNotMatch(renderMarkdown("run deploy_prod_now"), /<em>/);
  assert.match(renderMarkdown("an *emphasis* word"), /<em>emphasis<\/em>/);
});

test("renderMarkdown renders fences verbatim", () => {
  assert.match(renderMarkdown("```sh\nmake **all**\n```"), /<pre><code>make \*\*all\*\*<\/code><\/pre>/);
});

test("chartSeries accepts rows and column shapes", () => {
  assert.deepEqual(chartSeries([{ x: 1, p50: 3 }, { x: 2, p50: 4, p99: 9 }]), {
    x: [1, 2],
    series: [{ label: "p50", values: [3, 4] }, { label: "p99", values: [null, 9] }],
  });
  assert.equal(chartSeries({ x: [1], series: [{ values: [2] }] }).series[0].label, "series 1");
  assert.deepEqual(chartSeries(null), { x: [], series: [] });
});

test("statTiles accepts an object of label to value", () => {
  assert.deepEqual(statTiles({ errors: 3, p99: { value: 120, unit: "ms" } }), [
    { label: "errors", value: 3 },
    { label: "p99", value: 120, unit: "ms" },
  ]);
});

test("time helpers", () => {
  assert.equal(toMillis(1_700_000_000), 1_700_000_000_000);
  assert.equal(toMillis(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(formatDuration(65_000), "1m05s");
  assert.equal(formatDuration(3_725_000), "1h02m");
});

test("daemonAgents keeps agent services and their latest result", () => {
  const services = [
    { name: "oncall", on: "gate.approve", match: ["step=promote"], state: "waiting", env: { DJT_AGENT_BUDGET: "1.00" } },
    { name: "poller", state: "running", env: {} },
  ];
  const events = [
    { seq: 1, source: "svc:oncall", type: "agent.failed", payload: { error: "x" } },
    { seq: 2, source: "svc:other", type: "agent.done", payload: {} },
    { seq: 3, source: "svc:oncall", type: "agent.done", payload: { cost_usd: 0.1 } },
    { seq: 4, source: "svc:oncall", type: "svc.failed", payload: {} },
  ];
  const agents = daemonAgents(services, events);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, "oncall");
  assert.equal(agents[0].last.seq, 3);
  assert.equal(daemonAgents(services, [])[0].last, null);
});

test("agentStatus stands by while a CLI session is attached", () => {
  assert.equal(agentStatus({ state: "waiting" }, false), "armed");
  assert.equal(agentStatus({ state: "waiting" }, true), "standby");
  assert.equal(agentStatus({ state: "running" }, true), "running");
  assert.equal(agentStatus({ state: "stopped" }, false), "off");
});
