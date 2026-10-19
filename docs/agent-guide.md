# djt-hub — agent guide

`djt-hub` is a local daemon at `http://127.0.0.1:7717`. It hosts live browser
pages ("hubs") that you build and the user watches and clicks. Use one when a
task is a multi-step live process the user must follow or approve: releases,
migrations, backfills, long test runs, incident runbooks.

- One hub per process. Each hub is a folder with one React view you write: `view.tsx`.
- The page hot-reloads on every save of `view.tsx`, and re-renders on every state patch.
- You **attach** by running `listen` (or `wait`). User clicks reach you only while you are attached.
- With no agent attached, the page is read-only. It shows a banner telling the user to attach one.
- Every command prints JSON. Check the daemon with `djt-hub status`.

## Quick start

```sh
djt-hub create release-42 --title "Release 4.2"   # prints url and view_path
# edit view_path (see "Views" below), then:
djt-hub patch release-42 --json '[{"path":"steps","value":[
  {"id":"build","label":"Build","status":"running"},
  {"id":"promote","label":"Promote","status":"waiting","gate":"Promote to prod?"}]}]'
djt-hub open release-42                           # tell the user the URL too
djt-hub listen release-42                         # run under a background monitor
# ...each click prints one JSON line; act on it, then patch state...
djt-hub close release-42                          # when finished
```

## Attach

- `listen <hub>` attaches and prints each **user** event as one JSON line until stopped.
  Run it in the background (a Monitor, or `run_in_background`) so clicks wake you while you work.
  `--all` also prints agent events. `--since N` replays events after seq `N`.
- `wait <hub> [--type T] [--match k=v]... [--timeout 30m]` attaches until one matching
  event, prints it, and exits 0. It exits 2 on timeout. Use it for a single gate.
  `--match` reads dotted payload keys: `--match step=promote`, `--match values.env=prod`.
- Both reconnect across daemon restarts. The hub stays attached 60s after the last one exits,
  so a click between two `wait` calls still reaches you.
- When you stop listening, the page locks. That is the point: no click goes unanswered.
- `show <hub>` reports `attached`.

## Views

`create` writes a starter `view.tsx` that demos the kit. Replace it with whatever the
job needs. It must `export default` a React component. Edit it with your normal file
tools. The open page updates in place.

```tsx
import { Grid, Panel, Steps, Stats, Actions, Log, useHub } from "djt-hub";

export default function View() {
  const { state } = useHub();
  return (
    <Grid>
      <Panel eyebrow="Runbook" title="Release 4.2" width="two-thirds">
        <Steps id="run" bind="steps" />
      </Panel>
      <Panel eyebrow="Health" title="Now" width="third">
        <Stats bind="health" />
      </Panel>
      <Panel title="Activity" width="full">
        <Log events="*" />
      </Panel>
    </Grid>
  );
}
```

- Import only from `"djt-hub"` and `"react"`. The view runs in the user's browser, not in Node.
- Style with Tailwind classes. The theme tokens are `bg`, `surface`, `raised`, `line`
  (border), `ink` (text), `muted`, `faint`, `accent`, `ok`, `warn`, `bad`, `info`;
  fonts `font-display`, `font-body`, `font-mono`. Example: `className="text-muted font-mono"`.
- If the view fails to compile or throws, the page shows the error and `show <hub>`
  reports it as `view_error`. Fix the file; the page retries on its own.
- Keep changing data in state (`patch`), not in the view source.

### useHub()

`const hub = useHub()` gives:

- `state`, `get("a.b")`: the hub's state document.
- `attached`, `closed`, `canAct`: `canAct` is true while an agent is attached and the hub is open.
- `emit(type, payload)`: sends a user event to you. It returns `false` and does nothing unless `canAct`.
- `patch(path, value)`: writes state from the page, under the same rule.
- `events`: the last 500 hub events.

Gate your own buttons on `canAct`, or use the kit `Button`, which does it for you.

### Kit

Every kit component takes inline props, or `bind="path"` to read the same data from state.

| Component | Data | Emits |
|---|---|---|
| `Grid`, `Panel` | `Panel` props: `title`, `eyebrow`, `aside`, `width` (`full` `two-thirds` `half` `third` `quarter`), `flush` | |
| `Steps id` | `items` of `{id, label, status, detail, started_at, ended_at, time, gate}` | `gate.approve` / `gate.reject` `{block, step, note?}` |
| `Gate id prompt` | `approveLabel`, `rejectLabel`, `step` | same as above |
| `Actions id` | `items` of `{id, label, tone, confirm, disabled}`, `hint` | `action` `{block, action}` |
| `Form id` | `fields` of `{name, label, kind, options, value, placeholder, required}`, `submit`, `repeatable` | `form.submit` `{block, values}` |
| `Checklist id` | `items` of `{id, label, done, note}` | `checklist.toggle` `{block, item, done}`; with `bind` it also patches `done` |
| `Stats` | `items`: list of `{label, value, unit, tone, hint}`, or `{label: value \| {value, unit, tone, hint}}` | |
| `Table` | `rows`, `columns`: `["name", {"key":"status","kind":"status"}, {"key":"n","kind":"number"}]` | |
| `Chart` | `data` `{x, series:[{label, values, color}]}` or rows `[{x, a, b}]`; `kind` `line` `area` `bar`; `time`; `xLabel`, `yLabel`; `height` | |
| `Log` | `lines` (strings or `{ts, level, text}`), or `events="deploy."` for live hub events (`"*"` for all); `max` | |
| `Button` | `tone` `default` `primary` `danger`; disables itself while `!canAct` | your `onClick` |

- Step status: `pending` `running` `waiting` `done` `failed` `skipped`. Times are unix s or ms;
  running steps tick live. A gate shows only while its step is `waiting`.
- Tone: `ok` `warn` `bad` `info`.
- `id` is the `block` in every emitted payload, so you can tell controls apart.

## State and paths

Each hub has one JSON state document.

- `patch <hub> a.b=1 c=text` sets values. Values parse as JSON, else as a string.
- `patch <hub> --json '[{"path":"a","value":{...}}]'` sets several paths at once. `-` reads stdin, `@file` reads a file.
- Inside an array, a segment is an index (`steps.0`) or an element `id` (`steps.build`).
  Give list items an `id` so you never track positions.
- Setting `null` deletes the key or removes the array element.
- `get <hub> [path]` reads state. A patch is all or nothing.
- Patches replace the value at the path. To append to a list, read it, then write it back.

## Events

An event is `{"seq", "hub", "source", "type", "payload", "ts"}`. `source` is `user`
(the page) or `agent` (you). `emit <hub> <type> [json]` adds an agent event, for
example to feed a `Log events="deploy."`. `events <hub> [--since N] [--type T]`
prints the history.

## Conventions

- Tell the user the hub URL once, when you create it.
- Attach before you add anything clickable, and stay attached while the user may click.
- Keep the page the source of truth: update step status as work happens, not at the end.
- Never treat a click as done work. A gate or action asks; you act, then update state.
- `close` the hub when the process ends. Closed hubs stay readable at their URL.
- `ls` lists open hubs. Reuse one rather than creating duplicates.
- Hub ids are lowercase slugs. Commands take the hub from `--hub`, then `$DJT_HUB_ID`, then the first argument.
- Exit codes: 0 ok, 1 error, 2 `wait` timed out, 64 usage. Run `djt-hub help` for every command.
