# djt-hub

A small local web server an agent starts for one live process. The agent writes
the page as one React component (`view.tsx`), and the browser hot-reloads it on
every save. `djt-hub up <hub>` serves the page and attaches the agent: every
click the user makes reaches it as a JSON line. Nothing runs in the background.
The page goes down when that process stops.

- TypeScript on Bun: a Hono API plus Vite, which serves the views. One process per hub.
- Binds to `127.0.0.1` only, on the first free port from 7717. No auth.
- Hubs are plain files in `~/.local/share/djt-hub/hubs/<id>/`: `view.tsx`, `state.json`, `events.jsonl`, `hub.json`, and `server.json` while it is up.
- Site: https://tory37.github.io/djaunt-agent-hubs/

## Install

```sh
./install.sh            # bun install and the ~/.local/bin/djt-hub shim
```

Needs Bun (`brew install oven-sh/bun/bun`). Rerun `install.sh` after pulling to
upgrade. It also removes the launchd daemon that older versions installed.

## Use

```sh
djt-hub up release-42 --title "Release 4.2"   # serve + attach; first line is the URL
djt-hub patch release-42 steps.build.status=done
djt-hub docs                                  # the agent guide
djt-hub help                                  # every command
examples/release-runbook.sh                   # a reference release hub with a live gate
```

Views import a kit from `"djt-hub"`: `Steps` with gates, `Actions`, `Form`,
`Checklist`, `Stats`, `Table`, `Chart`, `Log`, `Grid`, `Panel`, and `useHub()`.
The agent guide is `docs/agent-guide.md`.

## Develop

```sh
bun test
bun run typecheck
DJT_HUB_DATA=/tmp/hubs djt-hub up demo   # a scratch hub outside your real data
```

Dependencies are pinned exactly. `bunfig.toml` refuses any release younger than 7 days.
