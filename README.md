# djt-hub

A small local daemon that hosts live browser hubs for agents. An agent builds a
page of blocks (steps with approval gates, checklists, stats, tables, charts,
logs, actions, forms, html) and the user watches it update live and clicks.
Clicks come back to the agent as events. Supervised services keep a hub
updating after the agent exits, and daemon agents answer clicks while no
session is listening.

- One Go binary: daemon, CLI, and embedded web UI.
- Binds to `127.0.0.1:7717` only. No auth.
- Data in `~/.local/share/djt-hub/` (SQLite plus service logs).

## Install

```sh
./install.sh            # builds ~/.local/bin/djt-hub, runs it under launchd
./install.sh --no-launchd
djt-hub uninstall       # removes the launchd agent, keeps data
```

Needs Go (`brew install go`). Rerun `install.sh` after pulling to upgrade.

## Use

```sh
djt-hub docs                         # the agent guide
djt-hub help                         # every command
examples/release-runbook.sh          # a reference release hub with a live gate
```

A daemon agent runs `claude -p` once per matching event, resuming one session:

```sh
djt-hub agent add release-42 oncall --on gate.approve --match step=promote \
  --prompt "Run the promote step, then mark it done" --allow "Bash(./promote.sh)"
```

The agent guide lives in `docs/agent-guide.md` and is embedded in the binary.

## Develop

```sh
go test -race ./...
node --test web/test/lib.test.mjs    # web lib tests
```
