# djt-hub — agent guide

`djt-hub` is a local daemon at `http://127.0.0.1:7717`. It hosts live browser
pages ("hubs") that an agent builds and the user watches and clicks. Use one
when a task is a multi-step live process the user must follow or approve:
releases, migrations, backfills, long test runs, incident runbooks.

- One hub per process. Hubs persist until closed; closing archives read-only.
- The agent writes blocks and state. The page re-renders live over SSE.
- User clicks become events. The agent reads them with `wait` or `events --follow`.
- Services are supervised commands that keep updating the hub after the agent exits.
- Check the daemon with `djt-hub status`. Every command prints JSON.

## Quick start

```sh
djt-hub create release-42 --title "Release 4.2"        # prints the URL
djt-hub block add release-42 '{"id":"run","type":"steps","title":"Runbook","bind":"steps"}'
djt-hub patch release-42 --json '[{"path":"steps","value":[
  {"id":"build","label":"Build","status":"running"},
  {"id":"promote","label":"Promote","status":"waiting","gate":"Promote to prod?"}]}]'
djt-hub open release-42                                  # tell the user too
djt-hub wait release-42 --match block=run --match step=promote --timeout 1h
djt-hub patch release-42 steps.promote.status=running
djt-hub close release-42                                 # when finished
```

## Hub id

Commands find the hub in this order: `--hub`, then `$DJT_HUB_ID`, then the first
argument. Ids are lowercase slugs (`release-42`). Export `DJT_HUB_ID` to drop it.

## State and paths

Each hub has one JSON state document. Blocks `bind` to a dotted path in it.

- `patch <hub> a.b=1 c=text` sets values. Values parse as JSON, else as a string.
- `patch <hub> --json '[{"path":"a","value":{...}}]'` sets several paths at once.
- Inside an array, a segment is an index (`steps.0`) or an element `id` (`steps.build`).
  Give list items an `id` so you never track positions.
- Setting `null` deletes the key or removes the array element.
- `get <hub> [path]` reads state.
- Patches replace the value at the path. To append to a list, read it, then write it back.

Prefer `bind` plus `patch` for data that changes. Inline data (`items`, `rows`,
`text`, ...) is fine for static blocks; change it with `block set`.

## Blocks

`block add <hub> <json|-|@file>` appends; `block set` replaces by `id` (or
appends); `block rm <hub> <id>` removes. Every block has:

- `id` (required, slug), `type` (required), `title`
- `width`: `full` (default) · `two-thirds` · `half` · `third` · `quarter` (12-column grid)
- `bind`: state path for the data. Without it, the data comes from the prop in brackets below.
- `height`: px number or CSS length, for table, chart, log, html

| type | data (`bind` or prop) | notes |
|---|---|---|
| `markdown` | string [`text`] | headings, lists, bold, code, links |
| `steps` | list [`items`] of `{id, label, status, detail, started_at, ended_at, time, gate}` | status: `pending` `running` `waiting` `done` `failed` `skipped`. Times are unix s or ms; running steps tick live |
| `checklist` | list [`items`] of `{id, label, done, note}` | a click emits `checklist.toggle` and, with `bind`, patches `done` |
| `stats` | list [`items`] of `{label, value, unit, tone, hint}`, or object `{label: value | {value, unit, tone, hint}}` | tone: `ok` `warn` `bad` `info` |
| `table` | list [`rows`] of objects | `columns`: `["name", {"key":"status","kind":"status","label":"State","align":"right"}]`. Default is the first row's keys |
| `chart` | [`data`] `{x:[...], series:[{label, values:[...], color}]}` or rows `[{x, a, b}]` | `kind`: `line` `area` `bar`; `time:true` reads x as unix time; `x_label`, `y_label`; string x values become categories |
| `log` | list [`lines`] of strings or `{ts, level, text}`, or one string | `events:"deploy."` instead shows live events whose type starts with the prefix (`"*"` for all); `max` lines (500) |
| `actions` | list [`items`] of `{id, label, tone, confirm, disabled}` | tone: `primary` `danger`; `confirm:true` or a string asks for a second click; `hint` |
| `form` | list [`fields`] of `{name, label, kind, options, value, placeholder, required}` | kind: `text` `textarea` `number` `select` `checkbox`; `submit` label; locks after one submit unless `repeatable:true` |
| `html` | string [`html`] | sandboxed iframe. See below |

A gate is a step with `gate` set (a prompt string, or `{prompt, approve, reject}`
for button labels). The gate shows only while that step's status is `waiting`.
The user can add a note. After a decision, move the step out of `waiting`.

### html block

Use it only when no block fits. The iframe runs scripts with an opaque origin.
It gets `window.hub`:

- `hub.state`, `hub.get("a.b")`, `hub.id`, `hub.archived`
- `hub.on("state", fn)` and `hub.on("event", fn)`. Both return an unsubscribe function.
- `hub.emit(type, payload)` and `hub.patch(path, value)`
- CSS variables match the page: `--bg`, `--surface`, `--text`, `--text-muted`, `--accent`, `--ok`, `--bad`, `--mono`

## Events

An event is `{"seq", "hub", "source", "type", "payload", "ts"}`. `source` is
`user`, `agent`, or `svc:<name>`. These are the events the page emits:

| type | payload |
|---|---|
| `gate.approve` / `gate.reject` | `{block, step, note?}` |
| `action` | `{block, action}` |
| `form.submit` | `{block, values:{name: value}}` |
| `checklist.toggle` | `{block, item, done}` |
| `svc.started` / `svc.exited` / `svc.failed` | `{pid}` / `{code, duration_ms}` / `{code, duration_ms}` or `{error}`; triggers add `seq` |
| `svc.dropped` | `{seq}`: a trigger's queue passed 100 events and dropped the oldest |

html blocks and `emit <hub> <type> [json]` can add any type.

### Wait for the user

- `wait <hub> [--type T] [--match k=v]... [--timeout 30m] [--since N]` blocks until
  a matching event arrives. It prints the event and exits 0.
- On timeout it exits 2. It considers only new events unless you pass `--since`.
- `--type` is an exact match. To catch both gate decisions, match the payload
  instead: `--match block=run --match step=promote`. Dotted keys work: `--match values.env=prod`.
- `wait` starts after you write the gate, so a quick click is never missed. If you
  need certainty, note `seq` from `show <hub>` first and pass `--since`.

### Follow the stream

- `events <hub> --follow` prints one JSON event per line until interrupted.
- It reconnects across daemon restarts.
- Run it under a background monitor to react to clicks while you work.
- `--since N` replays missed events. `--type T` filters. `--all-kinds` adds block and state changes.
- `events <hub>` without `--follow` prints the history.

## Services

The daemon runs services as `/bin/sh -c <command>` in their own process group.
They survive the agent exiting and daemon restarts. `close` and `delete` stop them.

```sh
djt-hub svc add release-42 p99 --every 30s -- 'djt-hub patch health.p99.value=$(./p99.sh)'
djt-hub svc add release-42 tail --restart always -- kubectl logs -f deploy/api
djt-hub svc add release-42 nightly --cron "0 3 * * *" -- ./report.sh
djt-hub svc ls release-42
djt-hub svc logs release-42 tail --tail 50 --follow
djt-hub svc stop|start|show|rm release-42 tail
```

- Put the command after `--`. One argument runs as a shell script. Several run as an argv list.
- `--every D` runs now, then every D. `--cron` (5 fields, local time) waits for the next match.
  A run is skipped while the last one is still going.
- `--restart` applies to long-running services: `on-failure` (default), `always`, or `never`.
  The delay doubles from 1s to 1m.
- `--cwd` defaults to the current directory. `--env K=V` is repeatable.
- Services get `$DJT_HUB_ID`, `$DJT_HUB_ADDR`, and `$DJT_SVC`. Plain `djt-hub patch` or
  `djt-hub emit` inside a service targets its hub with source `svc:<name>`.
- Output goes to `~/.local/share/djt-hub/logs/<hub>/<svc>.log`.
- Scheduled runs emit `svc.failed` only on failure. Long-running services also emit
  `svc.started` and `svc.exited`.

### Triggers

`--on TYPE` runs the command once per matching event instead of on a schedule.

```sh
djt-hub svc add release-42 on-reject --on gate.reject --match step=promote -- ./rollback.sh
```

- The event JSON arrives on stdin. `$DJT_EVENT_SEQ` and `$DJT_EVENT_TYPE` are set too.
- `--match k=v` filters on the payload, the same way `wait` does.
- Runs are one at a time, in event order. A trigger never fires on its own events.
- `--unattached` skips events while a CLI agent is listening. See below.
- A trigger reacts only to events after it was added or started. Events logged while the
  daemon was down still run on the next boot.
- A failed run emits `svc.failed` with the event `seq`.

### Attached agents

`wait` and `events --follow` mark the hub as attached. It stays attached for 2m after the
last one disconnects, so a click between two `wait` calls stays yours. `show` reports
`attached`. Browser tabs and services never attach a hub.

## Conventions

- Tell the user the hub URL once, when you create it.
- Keep the page the source of truth: update step status as work happens, not at the end.
- Never treat a click as done work. A gate or action asks; the agent acts, then updates state.
- `close` the hub when the process ends. Archived hubs stay readable at their URL.
- `ls` lists active hubs. Reuse one rather than creating duplicates.
- Exit codes: 0 ok, 1 error, 2 `wait` timed out, 64 usage.
- HTTP mirrors the CLI under `/api/hubs/...`. Run `djt-hub help` for the full command list.
