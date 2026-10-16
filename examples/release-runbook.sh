#!/usr/bin/env bash
# Reference hub: a release runbook with a promote gate, live metrics from a
# supervised service, and a tiny agent loop that reacts to the gate.
#   examples/release-runbook.sh [hub-id]     (default release-demo; recreated)
set -euo pipefail

hub="${1:-release-demo}"
export DJT_HUB_ID="$hub"
djt-hub status >/dev/null
djt-hub delete "$hub" >/dev/null 2>&1 || true
djt-hub create "$hub" --title "Release 3.2.0 — web + api" >/dev/null

djt-hub block add '{"id":"overview","type":"markdown","width":"two-thirds","title":"Overview","text":"Shipping **3.2.0** to prod. Rollback: `make rollback V=3.1.4`.\n\n- Canary at 5% for 15m\n- Watch p99 and error rate"}' >/dev/null
djt-hub block add '{"id":"kpi","type":"stats","width":"third","title":"Health","bind":"health"}' >/dev/null
djt-hub block add '{"id":"runbook","type":"steps","width":"two-thirds","title":"Runbook","bind":"steps"}' >/dev/null
djt-hub block add '{"id":"pre","type":"checklist","width":"third","title":"Pre-flight","bind":"pre"}' >/dev/null
djt-hub block add '{"id":"lat","type":"chart","width":"half","title":"Latency (ms)","bind":"lat","time":true}' >/dev/null
djt-hub block add '{"id":"services","type":"table","width":"half","title":"Services","bind":"services","columns":["name",{"key":"status","kind":"status"},"version","pods"]}' >/dev/null
djt-hub block add '{"id":"ops","type":"actions","width":"half","title":"Controls","items":[{"id":"pause","label":"Pause rollout"},{"id":"rollback","label":"Roll back","tone":"danger","confirm":true}],"hint":"Actions emit an event; the agent decides."}' >/dev/null
djt-hub block add '{"id":"signoff","type":"form","width":"half","title":"Sign-off","fields":[{"name":"owner","label":"On-call","placeholder":"name"},{"name":"env","label":"Env","kind":"select","options":["prod","stage"]},{"name":"notify","label":"Notify #releases","kind":"checkbox","value":true}],"submit":"Sign off"}' >/dev/null
djt-hub block add '{"id":"feed","type":"log","title":"Deploy log","events":"deploy."}' >/dev/null

now=$(date +%s)
times=$(seq -f %.0f -s, $((now - 600)) 30 "$now" | sed 's/,$//')
p50=$(for i in $(seq 0 20); do printf '%s,' $((60 + i % 5 * 4)); done | sed 's/,$//')
p99=$(for i in $(seq 0 20); do printf '%s,' $((180 + (i * 37) % 50)); done | sed 's/,$//')
djt-hub patch --json "[
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
  {\"name\":\"api\",\"status\":\"running\",\"version\":\"3.2.0\",\"pods\":3},
  {\"name\":\"web\",\"status\":\"done\",\"version\":\"3.2.0\",\"pods\":12},
  {\"name\":\"worker\",\"status\":\"pending\",\"version\":\"3.1.4\",\"pods\":8}]},
 {\"path\":\"lat\",\"value\":{\"x\":[$times],\"series\":[{\"label\":\"p50\",\"values\":[$p50]},{\"label\":\"p99\",\"values\":[$p99]}]}}]" >/dev/null
djt-hub emit deploy.started '{"step":"canary","pct":5}' >/dev/null

# A supervised service keeps the p99 tile live after this script exits.
djt-hub svc add metrics --every 2s -- \
  'djt-hub patch health.p99.value=$(awk "BEGIN{srand(); print 180 + int(rand() * 70)}") >/dev/null' >/dev/null

djt-hub open >/dev/null
echo "hub: http://${DJT_HUB_ADDR:-127.0.0.1:7717}/h/$hub — waiting for the promote gate"

# The agent loop: block on the gate, act, then update the page.
decision=$(djt-hub wait --match block=runbook --match step=promote --timeout 1h)
case "$decision" in
  *'"gate.approve"'*)
    djt-hub patch steps.promote.status=running "steps.promote.started_at=$(date +%s)" >/dev/null
    djt-hub emit deploy.promote '{"pct":100}' >/dev/null
    sleep 3
    djt-hub patch steps.promote.status=done "steps.promote.ended_at=$(date +%s)" \
      steps.verify.status=running health.canary.value=100 health.pods.value=60/60 >/dev/null
    djt-hub emit deploy.verify '{"suite":"smoke"}' >/dev/null
    sleep 3
    djt-hub patch steps.verify.status=done >/dev/null
    djt-hub emit deploy.finished '{"version":"3.2.0"}' >/dev/null
    echo "promoted" ;;
  *)
    djt-hub patch steps.promote.status=failed steps.promote.detail="rejected; rolled back to 3.1.4" \
      steps.verify.status=skipped health.canary.value=0 health.canary.tone=bad >/dev/null
    djt-hub emit deploy.rollback '{"to":"3.1.4"}' >/dev/null
    echo "rolled back" ;;
esac
djt-hub svc stop metrics >/dev/null
echo "done; 'djt-hub close $hub' archives it"
