# djt-hub

A small local web server where an agent builds a live page and then tags on to
it. The agent writes the page as one React component (`view.tsx`), and the
browser hot-reloads it on every save. The agent attaches with `djt-hub listen`.
From then on, every click the user makes reaches the agent as a JSON line.
With no agent attached, the page goes read-only and says so.

- TypeScript on Bun: a Hono API plus Vite, which serves the views. One process.
- Binds to `127.0.0.1:7717` only. No auth.
- Hubs are plain files in `~/.local/share/djt-hub/hubs/<id>/`: `view.tsx`, `state.json`, `events.jsonl`, `hub.json`.
- Site: https://tory37.github.io/djaunt-agent-hubs/

## Install

```sh
./install.sh            # bun install, ~/.local/bin/djt-hub shim, launchd
./install.sh --no-launchd
djt-hub uninstall       # removes the launchd agent, keeps data
```

Needs Bun (`brew install oven-sh/bun/bun`). Rerun `install.sh` after pulling to upgrade.

## Use

```sh
djt-hub create release-42 --title "Release 4.2"   # prints the URL and view_path
djt-hub listen release-42                         # attach; one JSON line per click
djt-hub docs                                      # the agent guide
djt-hub help                                      # every command
examples/release-runbook.sh                       # a reference release hub with a live gate
```

Views import a kit from `"djt-hub"`: `Steps` with gates, `Actions`, `Form`,
`Checklist`, `Stats`, `Table`, `Chart`, `Log`, `Grid`, `Panel`, and `useHub()`.
The agent guide is `docs/agent-guide.md`.

## Develop

```sh
bun test
bun run typecheck
bun run serve           # the daemon in the foreground (DJT_HUB_ADDR, DJT_HUB_DATA)
```

Dependencies are pinned exactly. `bunfig.toml` refuses any release younger than 7 days.
