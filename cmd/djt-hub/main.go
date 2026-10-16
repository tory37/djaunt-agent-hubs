package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/tory37/djaunt-agent-hubs/internal/client"
)

const usageText = `djt-hub — live local hubs for agents

Daemon
  serve [--addr A] [--data DIR] [--attach-grace 2m]
                                       run the daemon (launchd runs this)
  status                               exit 0 if the daemon answers
  install [--addr A] [--data DIR]      run the daemon under launchd (macOS)
  uninstall                            remove the launchd agent; keeps data
  docs                                 print the agent guide

Hubs
  create <hub> [--title T]             new hub; prints its URL
  ls [--all]                           list hubs (--all includes archived)
  show <hub>                           hub, blocks, state, last event seq
  open <hub>                           open the hub in the browser
  close <hub>                          archive read-only, stop its services
  delete <hub>                         remove a hub and all its data

Blocks
  block add <hub> <json|-|@file>       append a block {"id","type",...props}
  block set <hub> <json|-|@file>       replace a block in place (or append)
  block rm  <hub> <block-id>

State
  patch <hub> path=value...            values parse as JSON, else string
  patch <hub> --json <json|-|@file>    [{"path":"a.b","value":1}, ...]
  get <hub> [path]                     print state, or one value

Events
  emit <hub> <type> [json]             append an event
  events <hub> [--since N] [--type T] [--follow] [--all-kinds]
  wait <hub> [--type T] [--match k=v]... [--since N] [--timeout 30m]

Services (supervised; survive agent exit; stopped on close)
  svc add <hub> <name> [--every 30s | --cron "*/5 * * * *"]
          [--on TYPE [--match k=v]... [--unattached]]
          [--restart never|on-failure|always] [--cwd DIR] [--env K=V]...
          -- <command...>              one arg runs as a shell script
          --on runs once per matching event, event JSON on stdin
  svc ls <hub>                         services with state, pid, next run
  svc show|start|stop|rm <hub> <name>
  svc logs <hub> <name> [--tail N] [--follow]
  Services get $DJT_HUB_ID, $DJT_HUB_ADDR, $DJT_SVC, so plain
  "djt-hub patch a=1" or "djt-hub emit t" inside one targets its hub.

Hub resolution: --hub, then $DJT_HUB_ID, then the first argument.
Daemon address: $DJT_HUB_ADDR (default 127.0.0.1:7717).
`

type command func(ctx context.Context, args []string) error

var commands = map[string]command{
	"serve":     runServe,
	"status":    runStatus,
	"create":    runCreate,
	"ls":        runList,
	"show":      runShow,
	"open":      runOpen,
	"close":     runClose,
	"delete":    runDelete,
	"block":     runBlock,
	"patch":     runPatch,
	"get":       runGet,
	"emit":      runEmit,
	"events":    runEvents,
	"wait":      runWait,
	"svc":       runService,
	"docs":      runDocs,
	"install":   runInstall,
	"uninstall": runUninstall,
}

const (
	exitError       = 1
	exitWaitTimeout = 2
	exitUsage       = 64
)

func main() {
	if len(os.Args) < 2 || os.Args[1] == "help" || os.Args[1] == "-h" || os.Args[1] == "--help" {
		fmt.Print(usageText)
		return
	}
	run, isKnown := commands[os.Args[1]]
	if !isKnown {
		fmt.Fprintf(os.Stderr, "djt-hub: unknown command %q\n\n%s", os.Args[1], usageText)
		os.Exit(exitUsage)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	err := run(ctx, os.Args[2:])
	switch {
	case err == nil:
	case errors.Is(err, client.ErrWaitTimedOut):
		fmt.Fprintln(os.Stderr, "djt-hub:", err)
		os.Exit(exitWaitTimeout)
	case errors.Is(err, errUsage):
		fmt.Fprintf(os.Stderr, "djt-hub %s: %v\n", os.Args[1], err)
		os.Exit(exitUsage)
	case errors.Is(err, context.Canceled):
	default:
		fmt.Fprintln(os.Stderr, "djt-hub:", err)
		os.Exit(exitError)
	}
}

func newClient() *client.Client { return client.New(daemonAddress(), eventSource()) }
