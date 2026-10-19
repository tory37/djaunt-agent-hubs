#!/usr/bin/env bash
# Reference hub: a release runbook with a promote gate and live metrics. The
# script plays the agent: it brings the hub up, writes the view, and acts on
# the gate. The page goes down when the script exits.
#   examples/release-runbook.sh [hub-id]     (default release-demo; recreated)
set -euo pipefail

hub="${1:-release-demo}"
export DJT_HUB_ID="$hub"
djt-hub delete "$hub" >/dev/null 2>&1 || true

up_log="$(mktemp)"
djt-hub up "$hub" --title "Release 3.2.0 — web + api" > "$up_log" &
up_pid=$!
trap 'kill "$up_pid" ${metrics_pid:-} 2>/dev/null || true; rm -f "$up_log"' EXIT
until [ -s "$up_log" ]; do
  kill -0 "$up_pid" 2>/dev/null || exit 1
  sleep 0.1
done
view_path="$(head -1 "$up_log" | sed -n 's/.*"view_path":"\([^"]*\)".*/\1/p')"
url="$(head -1 "$up_log" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"

cat > "$view_path" <<'TSX'
import { Actions, Chart, Checklist, Grid, Log, Panel, Stats, Steps, Table, useHub } from "djt-hub";

export default function View() {
  const { state } = useHub();
  return (
    <Grid>
      <Panel eyebrow="Release 3.2.0" title="Runbook" width="two-thirds">
        <Steps id="runbook" bind="steps" />
      </Panel>
      <Panel eyebrow="Canary" title="Health" width="third">
        <Stats bind="health" />
      </Panel>
      <Panel eyebrow="Latency" title="p50 / p99 (ms)" width="half">
        <Chart bind="lat" time />
      </Panel>
      <Panel eyebrow="Fleet" title="Services" width="half">
        <Table bind="services" columns={["name", { key: "status", kind: "status" }, "version", { key: "pods", kind: "number" }]} />
      </Panel>
      <Panel eyebrow="Before promote" title="Pre-flight" width="third">
        <Checklist id="pre" bind="pre" />
      </Panel>
      <Panel eyebrow="Controls" title="Rollout" width="two-thirds">
        <Actions
          id="ops"
          items={[{ id: "pause", label: "Pause rollout" }, { id: "rollback", label: "Roll back", tone: "danger", confirm: true }]}
          hint={`Rollback target: ${String(state.rollback ?? "3.1.4")}. Actions ask; the agent decides.`}
        />
      </Panel>
      <Panel eyebrow="Events" title="Deploy log" width="full">
        <Log events="deploy." />
      </Panel>
    </Grid>
  );
}
TSX

now=$(date +%s)
times=$(seq -f %.0f -s, $((now - 600)) 30 "$now" | sed 's/,$//')
p50=$(for i in $(seq 0 20); do printf '%s,' $((60 + i % 5 * 4)); done | sed 's/,$//')
p99=$(for i in $(seq 0 20); do printf '%s,' $((180 + (i * 37) % 50)); done | sed 's/,$//')
djt-hub patch --json "[
 {\"path\":\"rollback\",\"value\":\"3.1.4\"},
 {\"path\":\"steps\",\"value\":[
  {\"id\":\"tag\",\"label\":\"Tag v3.2.0\",\"status\":\"done\",\"started_at\":$((now - 900)),\"ended_at\":$((now - 860))},
  {\"id\":\"build\",\"label\":\"Build and push images\",\"status\":\"done\",\"detail\":\"api, web, worker\",\"started_at\":$((now - 860)),\"ended_at\":$((now - 500))},
  {\"id\":\"stage\",\"label\":\"Deploy to stage\",\"status\":\"done\",\"started_at\":$((now - 500)),\"ended_at\":$((now - 380))},
  {\"id\":\"canary\",\"label\":\"Canary 5% in prod\",\"status\":\"done\",\"started_at\":$((now - 380)),\"ended_at\":$now},
  {\"id\":\"promote\",\"label\":\"Promote to 100%\",\"status\":\"waiting\",\"gate\":{\"prompt\":\"Canary is healthy. Promote to all pods?\",\"approve\":\"Promote\",\"reject\":\"Roll back\"}},
  {\"id\":\"verify\",\"label\":\"Post-deploy smoke tests\",\"status\":\"pending\"}]},
 {\"path\":\"health\",\"value\":{
  \"canary\":{\"value\":5,\"unit\":\"%\",\"tone\":\"info\"},
  \"p99\":{\"value\":212,\"unit\":\"ms\",\"tone\":\"ok\",\"hint\":\"budget 250\"},
  \"errors\":{\"value\":\"0.02\",\"unit\":\"%\",\"tone\":\"ok\"},
  \"pods\":{\"value\":\"3/60\"}}},
 {\"path\":\"pre\",\"value\":[
  {\"id\":\"freeze\",\"label\":\"Change freeze lifted\",\"done\":true},
  {\"id\":\"db\",\"label\":\"Migrations applied\",\"done\":true,\"note\":\"0042_add_index\"},
  {\"id\":\"oncall\",\"label\":\"On-call paged in\",\"done\":false}]},
 {\"path\":\"services\",\"value\":[
  {\"id\":\"api\",\"name\":\"api\",\"status\":\"running\",\"version\":\"3.2.0\",\"pods\":3},
  {\"id\":\"web\",\"name\":\"web\",\"status\":\"done\",\"version\":\"3.2.0\",\"pods\":12},
  {\"id\":\"worker\",\"name\":\"worker\",\"status\":\"pending\",\"version\":\"3.1.4\",\"pods\":8}]},
 {\"path\":\"lat\",\"value\":{\"x\":[$times],\"series\":[{\"label\":\"p50\",\"values\":[$p50]},{\"label\":\"p99\",\"values\":[$p99]}]}}]" >/dev/null
djt-hub emit deploy.started '{"step":"canary","pct":5}' >/dev/null

# Keep the p99 tile live while this agent stays attached.
(while true; do
  djt-hub patch "health.p99.value=$(awk 'BEGIN{srand(); print 180 + int(rand() * 70)}')" >/dev/null || true
  sleep 2
done) &
metrics_pid=$!

djt-hub open >/dev/null
echo "hub: $url — attached, waiting for the promote gate"

# up keeps the hub attached, so the gate unlocks while this script waits.
decision=$(djt-hub wait --match block=runbook --match step=promote --timeout 1h)
case "$decision" in
  *gate.approve*)
    djt-hub patch steps.promote.status=running "steps.promote.started_at=$(date +%s)" >/dev/null
    djt-hub emit deploy.promote '{"pct":100}' >/dev/null
    sleep 3
    djt-hub patch steps.promote.status=done "steps.promote.ended_at=$(date +%s)" \
      steps.verify.status=running "steps.verify.started_at=$(date +%s)" health.canary.value=100 health.pods.value=60/60 >/dev/null
    sleep 3
    djt-hub patch steps.verify.status=done "steps.verify.ended_at=$(date +%s)" services.worker.status=done services.worker.version=3.2.0 >/dev/null
    djt-hub emit deploy.done '{"version":"3.2.0"}' >/dev/null
    echo "promoted"
    ;;
  *gate.reject*)
    djt-hub patch steps.promote.status=failed steps.promote.detail="Rolled back to 3.1.4" steps.verify.status=skipped >/dev/null
    djt-hub emit deploy.rollback '{"to":"3.1.4"}' >/dev/null
    echo "rolled back"
    ;;
esac

kill "$metrics_pid" 2>/dev/null || true
metrics_pid=
echo "Ctrl-C takes the page down."
wait "$up_pid"
