package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/tory37/djaunt-agent-hubs/docs"
	"github.com/tory37/djaunt-agent-hubs/internal/client"
)

const (
	agentUsage = "agent add|ls|rm|reset <hub> ..."

	envAgentPrompt  = "DJT_AGENT_PROMPT"
	envAgentAllow   = "DJT_AGENT_ALLOW"
	envAgentModel   = "DJT_AGENT_MODEL"
	envAgentBudget  = "DJT_AGENT_BUDGET"
	envAgentTimeout = "DJT_AGENT_TIMEOUT"
	envClaude       = "DJT_HUB_CLAUDE"

	defaultAgentBudget  = "1.00"
	defaultAgentTimeout = 10 * time.Minute
	defaultAgentPrompt  = "React to this event as the hub's on-call agent."

	eventAgentDone   = "agent.done"
	eventAgentFailed = "agent.failed"
)

var defaultAgentTools = []string{"Read", "Grep", "Glob", "Bash(djt-hub:*)"}

const onCallRules = `

## You are this hub's daemon agent

The djt-hub daemon started you because an event arrived while no live session
was listening. The prompt holds the event and the hub as it is now.

- Act on the event. Then update the hub so the page shows what you did.
- Never run wait or events --follow. Exit when the work for this event is done.
- Plain djt-hub commands target this hub: $DJT_HUB_ID is set.
- If the event needs a human or a tool you do not have, say so on the hub and stop.
- You keep one session across events, so earlier events are in your history.
`

func runAgent(ctx context.Context, args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("%w: %s", errUsage, agentUsage)
	}
	subcommands := map[string]command{
		"add":   runAgentAdd,
		"ls":    runAgentList,
		"rm":    runAgentRemove,
		"reset": runAgentReset,
		"run":   runAgentRun,
	}
	run, isKnown := subcommands[args[0]]
	if !isKnown {
		return fmt.Errorf("%w: unknown agent command %q; %s", errUsage, args[0], agentUsage)
	}
	return run(ctx, args[1:])
}

// runAgentAdd stores a Claude agent as an unattached trigger whose command is
// `djt-hub agent run`. Its options live in the service env.
func runAgentAdd(ctx context.Context, args []string) error {
	var onType, prompt, model, budget, workdir string
	var timeout time.Duration
	var matchers, extraTools stringList
	hubID, positionals, err := hubCommand("agent add", args, func(flags *flag.FlagSet) {
		flags.StringVar(&onType, "on", "", "event type that wakes the agent")
		flags.Var(&matchers, "match", "payload key=value (dotted keys ok); repeatable")
		flags.StringVar(&prompt, "prompt", "", "standing instructions, or @file")
		flags.Var(&extraTools, "allow", "extra Claude tool to allow, e.g. Bash(git:*); repeatable")
		flags.StringVar(&model, "model", "", "Claude model (default: Claude's own)")
		flags.StringVar(&budget, "budget", defaultAgentBudget, "max USD per run")
		flags.DurationVar(&timeout, "timeout", defaultAgentTimeout, "kill a run after this long")
		flags.StringVar(&workdir, "cwd", "", "working directory (default current)")
	})
	if err != nil {
		return err
	}
	if len(positionals) != 1 || onType == "" {
		return fmt.Errorf("%w: agent add <hub> <name> --on TYPE [--match k=v]... [--prompt TEXT|@file] [--allow TOOL]... [--model M] [--budget USD] [--timeout D] [--cwd DIR]", errUsage)
	}
	if amount, err := strconv.ParseFloat(budget, 64); err != nil || amount <= 0 {
		return fmt.Errorf("%w: budget %q must be a positive USD amount", errUsage, budget)
	}
	if strings.HasPrefix(prompt, "@") {
		content, err := os.ReadFile(strings.TrimPrefix(prompt, "@"))
		if err != nil {
			return err
		}
		prompt = string(content)
	}
	if workdir, err = resolveWorkdir(workdir); err != nil {
		return err
	}
	env := map[string]string{
		envAgentPrompt:  prompt,
		envAgentAllow:   strings.Join(extraTools, "\n"),
		envAgentModel:   model,
		envAgentBudget:  budget,
		envAgentTimeout: timeout.String(),
	}
	request := map[string]any{
		"name":       positionals[0],
		"command":    "djt-hub agent run",
		"workdir":    workdir,
		"env":        env,
		"on":         onType,
		"match":      matchers,
		"unattached": true,
	}
	return doAndPrint(ctx, http.MethodPost, client.HubPath(hubID, "services"), request)
}

func runAgentList(ctx context.Context, args []string) error {
	hubID, _, err := hubCommand("agent ls", args, nil)
	if err != nil {
		return err
	}
	var services []json.RawMessage
	if err := newClient().Do(ctx, http.MethodGet, client.HubPath(hubID, "services"), nil, &services); err != nil {
		return err
	}
	agents := []json.RawMessage{}
	for _, service := range services {
		var fields struct {
			Env map[string]string `json:"env"`
		}
		json.Unmarshal(service, &fields)
		if _, isAgent := fields.Env[envAgentBudget]; isAgent {
			agents = append(agents, service)
		}
	}
	return printJSON(agents)
}

func runAgentRemove(ctx context.Context, args []string) error {
	hubID, positionals, err := hubCommand("agent rm", args, nil)
	if err != nil {
		return err
	}
	if len(positionals) != 1 {
		return fmt.Errorf("%w: agent rm <hub> <name>", errUsage)
	}
	if err := forgetSession(hubID, positionals[0]); err != nil {
		return err
	}
	return doAndPrint(ctx, http.MethodDelete, client.HubPath(hubID, "services", positionals[0]), nil)
}

func runAgentReset(ctx context.Context, args []string) error {
	hubID, positionals, err := hubCommand("agent reset", args, nil)
	if err != nil {
		return err
	}
	if len(positionals) != 1 {
		return fmt.Errorf("%w: agent reset <hub> <name>", errUsage)
	}
	if err := forgetSession(hubID, positionals[0]); err != nil {
		return err
	}
	return printJSON(map[string]any{"hub": hubID, "agent": positionals[0], "reset": true})
}

func sessionPath(hubID, agentName string) string {
	return filepath.Join(dataDir(), "agents", hubID, agentName+".session")
}

func forgetSession(hubID, agentName string) error {
	err := os.Remove(sessionPath(hubID, agentName))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

type claudeResult struct {
	SessionID string  `json:"session_id"`
	CostUSD   float64 `json:"total_cost_usd"`
	Turns     int     `json:"num_turns"`
	IsError   bool    `json:"is_error"`
	Subtype   string  `json:"subtype"`
	Result    string  `json:"result"`
}

// runAgentRun is the command an agent service runs per event. It reports the
// outcome as agent.done or agent.failed and exits 0 once that is recorded.
func runAgentRun(ctx context.Context, args []string) error {
	hubID, agentName := os.Getenv(envHubID), os.Getenv(envServiceName)
	if hubID == "" || agentName == "" {
		return fmt.Errorf("%w: agent run runs inside an agent service; see agent add", errUsage)
	}
	rawEvent, err := io.ReadAll(os.Stdin)
	if err != nil {
		return err
	}
	var event struct {
		Seq int64 `json:"seq"`
	}
	if err := json.Unmarshal(rawEvent, &event); err != nil {
		return fmt.Errorf("agent run: event on stdin: %w", err)
	}
	hubClient := newClient()
	var snapshot json.RawMessage
	if err := hubClient.Do(ctx, http.MethodGet, client.HubPath(hubID), nil, &snapshot); err != nil {
		return err
	}
	prompt := agentPrompt(hubID, rawEvent, snapshot)

	path := sessionPath(hubID, agentName)
	sessionID := ""
	if saved, err := os.ReadFile(path); err == nil {
		sessionID = strings.TrimSpace(string(saved))
	}
	result, err := runClaude(ctx, sessionID, prompt)
	// A session Claude no longer has would fail every run, so start fresh once.
	if err != nil && sessionID != "" && ctx.Err() == nil {
		fmt.Fprintf(os.Stderr, "agent run: resume %s failed (%v); starting a new session\n", sessionID, err)
		result, err = runClaude(ctx, "", prompt)
	}
	if err == nil && result.SessionID != "" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(path, []byte(result.SessionID+"\n"), 0o644); err != nil {
			return err
		}
	}
	if result.Result != "" {
		fmt.Println(result.Result)
	}

	eventType, payload := eventAgentDone, map[string]any{"seq": event.Seq, "cost_usd": result.CostUSD, "turns": result.Turns}
	switch {
	case err != nil:
		eventType, payload = eventAgentFailed, map[string]any{"seq": event.Seq, "error": err.Error()}
	case result.IsError:
		eventType, payload["error"] = eventAgentFailed, cmp.Or(result.Subtype, "claude reported an error")
	}
	return hubClient.Do(ctx, http.MethodPost, client.HubPath(hubID, "events"), map[string]any{"type": eventType, "payload": payload}, nil)
}

func agentPrompt(hubID string, rawEvent, snapshot []byte) string {
	instructions := cmp.Or(os.Getenv(envAgentPrompt), defaultAgentPrompt)
	return fmt.Sprintf("%s\n\nEvent on hub %s:\n%s\n\nThe hub now (blocks and state):\n%s\n",
		strings.TrimSpace(instructions), hubID, bytes.TrimSpace(rawEvent), snapshot)
}

func runClaude(ctx context.Context, sessionID, prompt string) (claudeResult, error) {
	timeout, err := time.ParseDuration(os.Getenv(envAgentTimeout))
	if err != nil || timeout <= 0 {
		timeout = defaultAgentTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	command := exec.CommandContext(ctx, cmp.Or(os.Getenv(envClaude), "claude"), claudeArgs(sessionID)...)
	command.Stdin = strings.NewReader(prompt)
	var stdout bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = os.Stderr
	runErr := command.Run()

	var result claudeResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		if runErr == nil {
			runErr = fmt.Errorf("unreadable claude output: %w", err)
		}
		if ctx.Err() == context.DeadlineExceeded {
			runErr = fmt.Errorf("claude ran past %s", timeout)
		}
		return claudeResult{}, fmt.Errorf("claude: %w", runErr)
	}
	result.IsError = result.IsError || runErr != nil
	return result, nil
}

func claudeArgs(sessionID string) []string {
	tools := slices.Clone(defaultAgentTools)
	for _, tool := range strings.Split(os.Getenv(envAgentAllow), "\n") {
		if tool = strings.TrimSpace(tool); tool != "" {
			tools = append(tools, tool)
		}
	}
	args := []string{
		"-p", "--output-format", "json",
		"--allowedTools", strings.Join(tools, ","),
		"--append-system-prompt", docs.AgentGuide + onCallRules,
		"--max-budget-usd", cmp.Or(os.Getenv(envAgentBudget), defaultAgentBudget),
	}
	if model := os.Getenv(envAgentModel); model != "" {
		args = append(args, "--model", model)
	}
	if sessionID != "" {
		args = append(args, "--resume", sessionID)
	}
	return args
}
