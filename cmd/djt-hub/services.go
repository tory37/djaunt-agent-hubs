package main

import (
	"context"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/tory37/djaunt-agent-hubs/internal/client"
)

const serviceUsage = "svc add|ls|show|logs|start|stop|rm <hub> ..."

func runService(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("%w: %s", errUsage, serviceUsage)
	}
	subcommands := map[string]command{
		"add":   runServiceAdd,
		"ls":    runServiceList,
		"show":  serviceAction(http.MethodGet, ""),
		"start": serviceAction(http.MethodPost, "start"),
		"stop":  serviceAction(http.MethodPost, "stop"),
		"rm":    serviceAction(http.MethodDelete, ""),
		"logs":  runServiceLogs,
	}
	run, isKnown := subcommands[args[0]]
	if !isKnown {
		return fmt.Errorf("%w: unknown svc command %q; %s", errUsage, args[0], serviceUsage)
	}
	return run(ctx, args[1:])
}

func runServiceAdd(ctx context.Context, args []string) error {
	var every, cronExpression, restart, workdir, onType string
	var envAssignments, matchers stringList
	var unattached bool
	hubID, positionals, err := hubCommand("svc add", args, func(flags *flag.FlagSet) {
		flags.StringVar(&every, "every", "", "run on an interval, e.g. 30s")
		flags.StringVar(&cronExpression, "cron", "", "run on a 5-field cron schedule")
		flags.StringVar(&onType, "on", "", "run once per event of this type; the event JSON is on stdin")
		flags.Var(&matchers, "match", "with --on, payload key=value (dotted keys ok); repeatable")
		flags.BoolVar(&unattached, "unattached", false, "with --on, skip events while a CLI agent listens")
		flags.StringVar(&restart, "restart", "", "never|on-failure|always (default on-failure)")
		flags.StringVar(&workdir, "cwd", "", "working directory (default current)")
		flags.Var(&envAssignments, "env", "KEY=VALUE, repeatable")
	})
	if err != nil {
		return err
	}
	if len(positionals) < 2 {
		return fmt.Errorf("%w: svc add <hub> <name> [--every D|--cron EXPR|--on TYPE [--match k=v]... [--unattached]] [--restart P] [--cwd DIR] [--env K=V]... -- <command>", errUsage)
	}
	if workdir, err = resolveWorkdir(workdir); err != nil {
		return err
	}
	env := map[string]string{}
	for _, assignment := range envAssignments {
		key, value, hasEquals := strings.Cut(assignment, "=")
		if !hasEquals || key == "" {
			return fmt.Errorf("%w: env %q must be KEY=VALUE", errUsage, assignment)
		}
		env[key] = value
	}
	request := map[string]any{
		"name":       positionals[0],
		"command":    shellCommand(positionals[1:]),
		"workdir":    workdir,
		"env":        env,
		"every":      every,
		"cron":       cronExpression,
		"restart":    restart,
		"on":         onType,
		"match":      matchers,
		"unattached": unattached,
	}
	return doAndPrint(ctx, http.MethodPost, client.HubPath(hubID, "services"), request)
}

func resolveWorkdir(workdir string) (string, error) {
	if workdir == "" {
		return os.Getwd()
	}
	return filepath.Abs(workdir)
}

// shellCommand keeps a single argument as a shell script and quotes several
// arguments as an argv list, so `-- sh -c 'a | b'` survives intact.
func shellCommand(words []string) string {
	if len(words) == 1 {
		return words[0]
	}
	quoted := make([]string, len(words))
	for index, word := range words {
		quoted[index] = "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
	}
	return strings.Join(quoted, " ")
}

func runServiceList(ctx context.Context, args []string) error {
	hubID, _, err := hubCommand("svc ls", args, nil)
	if err != nil {
		return err
	}
	return doAndPrint(ctx, http.MethodGet, client.HubPath(hubID, "services"), nil)
}

func serviceAction(method, action string) command {
	return func(ctx context.Context, args []string) error {
		hubID, positionals, err := hubCommand("svc", args, nil)
		if err != nil {
			return err
		}
		if len(positionals) != 1 {
			return fmt.Errorf("%w: svc %s <hub> <name>", errUsage, action)
		}
		path := client.HubPath(hubID, "services", positionals[0])
		if action != "" {
			path += "/" + action
		}
		return doAndPrint(ctx, method, path, nil)
	}
}

func runServiceLogs(ctx context.Context, args []string) error {
	var tail int
	var follow bool
	hubID, positionals, err := hubCommand("svc logs", args, func(flags *flag.FlagSet) {
		flags.IntVar(&tail, "tail", 200, "last N lines (0 = all)")
		flags.BoolVar(&follow, "follow", false, "keep streaming new output")
	})
	if err != nil {
		return err
	}
	if len(positionals) != 1 {
		return fmt.Errorf("%w: svc logs <hub> <name> [--tail N] [--follow]", errUsage)
	}
	query := url.Values{"tail": {strconv.Itoa(tail)}}
	if follow {
		query.Set("follow", "1")
	}
	path := client.HubPath(hubID, "services", positionals[0], "logs") + "?" + query.Encode()
	return newClient().CopyText(ctx, path, os.Stdout)
}
