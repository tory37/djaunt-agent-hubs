package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/tory37/djaunt-agent-hubs/internal/client"
	"github.com/tory37/djaunt-agent-hubs/internal/server"
	"github.com/tory37/djaunt-agent-hubs/internal/store"
	"github.com/tory37/djaunt-agent-hubs/web"
)

const (
	shutdownGracePeriod = 5 * time.Second
	followRetryDelay    = time.Second
)

func runServe(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	address := flags.String("addr", daemonAddress(), "listen address (loopback only)")
	dataDirectory := flags.String("data", dataDir(), "data directory")
	if _, err := parseArgs(flags, args); err != nil {
		return err
	}
	if err := requireLoopback(*address); err != nil {
		return err
	}

	hubStore, err := store.Open(filepath.Join(*dataDirectory, "hub.db"))
	if err != nil {
		return err
	}
	defer hubStore.Close()

	hubServer := server.New(hubStore, web.Handler())
	listener, err := net.Listen("tcp", *address)
	if err != nil {
		return err
	}
	httpServer := &http.Server{Handler: hubServer, ReadHeaderTimeout: 10 * time.Second}
	fmt.Fprintf(os.Stderr, "djt-hub serving http://%s (data %s)\n", listener.Addr(), *dataDirectory)

	serveErrors := make(chan error, 1)
	go func() { serveErrors <- httpServer.Serve(listener) }()
	select {
	case err := <-serveErrors:
		return err
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), shutdownGracePeriod)
		defer cancel()
		return httpServer.Shutdown(shutdownContext)
	}
}

func requireLoopback(address string) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("%w: addr %q: %v", errUsage, address, err)
	}
	if host == "localhost" {
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return fmt.Errorf("%w: addr %q must be a loopback address; hubs are local-only", errUsage, address)
	}
	return nil
}

func runStatus(ctx context.Context, args []string) error {
	hubClient := newClient()
	if err := hubClient.Do(ctx, http.MethodGet, "/api/health", nil, nil); err != nil {
		return err
	}
	fmt.Printf("djt-hub running at %s\n", hubClient.BaseURL())
	return nil
}

func hubURL(hubClient *client.Client, hubID string) string {
	return hubClient.BaseURL() + "/h/" + url.PathEscape(hubID)
}

func runCreate(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("create", flag.ContinueOnError)
	title := flags.String("title", "", "hub title")
	positionals, err := parseArgs(flags, args)
	if err != nil {
		return err
	}
	if len(positionals) != 1 {
		return fmt.Errorf("%w: create <hub> [--title T]", errUsage)
	}
	hubClient := newClient()
	var hub store.Hub
	request := map[string]string{"id": positionals[0], "title": *title}
	if err := hubClient.Do(ctx, http.MethodPost, "/api/hubs", request, &hub); err != nil {
		return err
	}
	return printJSON(map[string]any{"hub": hub, "url": hubURL(hubClient, hub.ID)})
}

func runList(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("ls", flag.ContinueOnError)
	includeArchived := flags.Bool("all", false, "include archived hubs")
	if _, err := parseArgs(flags, args); err != nil {
		return err
	}
	path := "/api/hubs"
	if *includeArchived {
		path += "?all=1"
	}
	var hubs json.RawMessage
	if err := newClient().Do(ctx, http.MethodGet, path, nil, &hubs); err != nil {
		return err
	}
	return printRawJSON(hubs)
}

// hubCommand parses flags common to every command that targets one hub.
func hubCommand(name string, args []string, register func(*flag.FlagSet)) (string, []string, error) {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	explicitHub := flags.String("hub", "", "hub id")
	if register != nil {
		register(flags)
	}
	positionals, err := parseArgs(flags, args)
	if err != nil {
		return "", nil, err
	}
	return resolveHub(*explicitHub, positionals)
}

func runShow(ctx context.Context, args []string) error {
	hubID, _, err := hubCommand("show", args, nil)
	if err != nil {
		return err
	}
	var snapshot json.RawMessage
	if err := newClient().Do(ctx, http.MethodGet, client.HubPath(hubID), nil, &snapshot); err != nil {
		return err
	}
	return printRawJSON(snapshot)
}

func runOpen(ctx context.Context, args []string) error {
	hubID, _, err := hubCommand("open", args, nil)
	if err != nil {
		return err
	}
	hubClient := newClient()
	if err := hubClient.Do(ctx, http.MethodGet, client.HubPath(hubID), nil, nil); err != nil {
		return err
	}
	link := hubURL(hubClient, hubID)
	fmt.Println(link)
	opener := "xdg-open"
	if runtime.GOOS == "darwin" {
		opener = "open"
	}
	return exec.Command(opener, link).Start()
}

func runClose(ctx context.Context, args []string) error {
	hubID, _, err := hubCommand("close", args, nil)
	if err != nil {
		return err
	}
	return doAndPrint(ctx, http.MethodPost, client.HubPath(hubID, "close"), nil)
}

func runDelete(ctx context.Context, args []string) error {
	hubID, _, err := hubCommand("delete", args, nil)
	if err != nil {
		return err
	}
	return doAndPrint(ctx, http.MethodDelete, client.HubPath(hubID), nil)
}

func runBlock(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("%w: block add|set|rm <hub> ...", errUsage)
	}
	action, actionArgs := args[0], args[1:]
	hubID, positionals, err := hubCommand("block "+action, actionArgs, nil)
	if err != nil {
		return err
	}
	if len(positionals) != 1 {
		return fmt.Errorf("%w: block %s <hub> <json|-|@file|block-id>", errUsage, action)
	}

	switch action {
	case "rm":
		return doAndPrint(ctx, http.MethodDelete, client.HubPath(hubID, "blocks", positionals[0]), nil)
	case "add", "set":
		body, err := readJSONArgument(positionals[0])
		if err != nil {
			return err
		}
		if action == "add" {
			return doAndPrint(ctx, http.MethodPost, client.HubPath(hubID, "blocks"), body)
		}
		var withID struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(body, &withID); err != nil || withID.ID == "" {
			return fmt.Errorf("%w: block set needs JSON with an \"id\"", errUsage)
		}
		return doAndPrint(ctx, http.MethodPut, client.HubPath(hubID, "blocks", withID.ID), body)
	default:
		return fmt.Errorf("%w: unknown block action %q", errUsage, action)
	}
}

func runPatch(ctx context.Context, args []string) error {
	var patchJSON string
	hubID, assignments, err := hubCommand("patch", args, func(flags *flag.FlagSet) {
		flags.StringVar(&patchJSON, "json", "", "patch list as JSON, - or @file")
	})
	if err != nil {
		return err
	}

	var body []byte
	if patchJSON != "" {
		body, err = readJSONArgument(patchJSON)
		if err != nil {
			return err
		}
	} else {
		patches, err := parseAssignments(assignments)
		if err != nil {
			return err
		}
		body, _ = json.Marshal(patches)
	}
	var document json.RawMessage
	return newClient().Do(ctx, http.MethodPatch, client.HubPath(hubID, "state"), body, &document)
}

func parseAssignments(assignments []string) ([]store.Patch, error) {
	if len(assignments) == 0 {
		return nil, fmt.Errorf("%w: patch <hub> path=value... or --json", errUsage)
	}
	patches := make([]store.Patch, 0, len(assignments))
	for _, assignment := range assignments {
		path, rawValue, hasEquals := strings.Cut(assignment, "=")
		if !hasEquals {
			return nil, fmt.Errorf("%w: %q is not path=value", errUsage, assignment)
		}
		var value any
		if err := json.Unmarshal([]byte(rawValue), &value); err != nil {
			value = rawValue
		}
		patches = append(patches, store.Patch{Path: path, Value: value})
	}
	return patches, nil
}

func runGet(ctx context.Context, args []string) error {
	hubID, positionals, err := hubCommand("get", args, nil)
	if err != nil {
		return err
	}
	path := client.HubPath(hubID, "state")
	if len(positionals) > 0 {
		path += "?path=" + url.QueryEscape(positionals[0])
	}
	var value json.RawMessage
	if err := newClient().Do(ctx, http.MethodGet, path, nil, &value); err != nil {
		return err
	}
	return printRawJSON(value)
}

func runEmit(ctx context.Context, args []string) error {
	hubID, positionals, err := hubCommand("emit", args, nil)
	if err != nil {
		return err
	}
	if len(positionals) < 1 || len(positionals) > 2 {
		return fmt.Errorf("%w: emit <hub> <type> [json|-|@file]", errUsage)
	}
	request := map[string]any{"type": positionals[0]}
	if len(positionals) == 2 {
		payload, err := readJSONArgument(positionals[1])
		if err != nil {
			return err
		}
		request["payload"] = json.RawMessage(payload)
	}
	return doAndPrint(ctx, http.MethodPost, client.HubPath(hubID, "events"), request)
}

func runEvents(ctx context.Context, args []string) error {
	var since int64
	var eventType string
	var follow, allKinds bool
	hubID, _, err := hubCommand("events", args, func(flags *flag.FlagSet) {
		flags.Int64Var(&since, "since", 0, "only events after this seq")
		flags.StringVar(&eventType, "type", "", "only this event type")
		flags.BoolVar(&follow, "follow", false, "stream new events until interrupted")
		flags.BoolVar(&allKinds, "all-kinds", false, "with --follow, also print block/state/hub changes")
	})
	if err != nil {
		return err
	}
	hubClient := newClient()

	if !follow {
		query := url.Values{}
		query.Set("since", strconv.FormatInt(since, 10))
		if eventType != "" {
			query.Set("type", eventType)
		}
		var events []json.RawMessage
		if err := hubClient.Do(ctx, http.MethodGet, client.HubPath(hubID, "events")+"?"+query.Encode(), nil, &events); err != nil {
			return err
		}
		for _, event := range events {
			fmt.Println(string(event))
		}
		return nil
	}

	printMessage := func(message client.StreamMessage) {
		if message.Kind == server.MessageEvent {
			fmt.Println(string(message.Data))
			return
		}
		if allKinds {
			line, _ := json.Marshal(map[string]any{"kind": message.Kind, "data": message.Data})
			fmt.Println(string(line))
		}
	}
	// Reconnect forever so a daemon restart never silently ends a follow
	// running under an agent's monitor.
	for {
		since, err = hubClient.Stream(ctx, hubID, since, eventType, printMessage)
		var apiError *client.APIError
		if errors.As(err, &apiError) {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(followRetryDelay):
		}
	}
}

func runWait(ctx context.Context, args []string) error {
	var options client.WaitOptions
	var matchers stringList
	hubID, _, err := hubCommand("wait", args, func(flags *flag.FlagSet) {
		flags.StringVar(&options.Type, "type", "", "event type to wait for")
		flags.Var(&matchers, "match", "payload key=value (dotted keys ok); repeatable")
		flags.StringVar(&options.Since, "since", "", "consider events after this seq (default: now)")
		flags.StringVar(&options.Timeout, "timeout", "", "give up after this duration (default 30m)")
	})
	if err != nil {
		return err
	}
	options.Matchers = matchers
	event, err := newClient().Wait(ctx, hubID, options)
	if err != nil {
		return err
	}
	fmt.Println(string(event))
	return nil
}

func doAndPrint(ctx context.Context, method, path string, body any) error {
	var response json.RawMessage
	if err := newClient().Do(ctx, method, path, body, &response); err != nil {
		return err
	}
	return printRawJSON(response)
}

func printJSON(value any) error {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}

func printRawJSON(raw json.RawMessage) error {
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		fmt.Println(string(raw))
		return nil
	}
	return printJSON(value)
}
