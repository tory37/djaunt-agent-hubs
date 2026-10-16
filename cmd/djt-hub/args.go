package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	defaultAddress = "127.0.0.1:7717"
	envAddress     = "DJT_HUB_ADDR"
	envDataDir     = "DJT_HUB_DATA"
	envHubID       = "DJT_HUB_ID"
	envServiceName = "DJT_SVC"
	envSource      = "DJT_HUB_SOURCE"
)

var errUsage = errors.New("usage")

func daemonAddress() string {
	if address := os.Getenv(envAddress); address != "" {
		return address
	}
	return defaultAddress
}

func dataDir() string {
	if dir := os.Getenv(envDataDir); dir != "" {
		return dir
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".local", "share", "djt-hub")
}

func eventSource() string {
	if serviceName := os.Getenv(envServiceName); serviceName != "" {
		return "svc:" + serviceName
	}
	if source := os.Getenv(envSource); source != "" {
		return source
	}
	return "agent"
}

type stringList []string

func (list *stringList) String() string         { return strings.Join(*list, ",") }
func (list *stringList) Set(value string) error { *list = append(*list, value); return nil }

// parseArgs lets flags appear anywhere among positionals, so agents can write
// `wait release-42 --type gate.approve` as naturally as the reverse.
func parseArgs(flags *flag.FlagSet, args []string) ([]string, error) {
	flags.SetOutput(io.Discard)
	var positionals []string
	for {
		if err := flags.Parse(args); err != nil {
			return nil, fmt.Errorf("%w: %v", errUsage, err)
		}
		remaining := flags.Args()
		if len(remaining) == 0 {
			return positionals, nil
		}
		positionals = append(positionals, remaining[0])
		args = remaining[1:]
	}
}

// resolveHub takes the hub from --hub, then $DJT_HUB_ID (set for supervised
// services), then the first positional.
func resolveHub(explicitHub string, positionals []string) (string, []string, error) {
	if explicitHub != "" {
		return explicitHub, positionals, nil
	}
	if envHub := os.Getenv(envHubID); envHub != "" {
		return envHub, positionals, nil
	}
	if len(positionals) == 0 {
		return "", nil, fmt.Errorf("%w: missing hub id", errUsage)
	}
	return positionals[0], positionals[1:], nil
}

// readJSONArgument accepts inline JSON, "-" for stdin, or @path for a file.
func readJSONArgument(argument string) ([]byte, error) {
	switch {
	case argument == "-":
		return io.ReadAll(os.Stdin)
	case strings.HasPrefix(argument, "@"):
		return os.ReadFile(strings.TrimPrefix(argument, "@"))
	default:
		return []byte(argument), nil
	}
}
