package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeClaude records each call's argv (one arg per line) and prompt, then
// prints a result. A prompt containing "boom" reports an error.
const fakeClaude = `#!/bin/sh
dir=$(dirname "$0")
n=$(ls "$dir" | grep -c '^call\.')
printf '%s\n' "$@" > "$dir/call.$n"
cat > "$dir/prompt.$n"
if grep -q boom "$dir/prompt.$n"; then
  echo '{"type":"result","subtype":"error_max_budget_usd","is_error":true,"session_id":"sess-1","total_cost_usd":1,"num_turns":9}'
  exit 1
fi
echo '{"type":"result","subtype":"success","is_error":false,"result":"marked done","session_id":"sess-1","total_cost_usd":0.25,"num_turns":3}'
`

func installFakeClaude(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "claude")
	if err := os.WriteFile(path, []byte(fakeClaude), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv(envClaude, path)
	return dir
}

func readCall(t *testing.T, dir string, index int) (args, prompt string) {
	t.Helper()
	argv, err := os.ReadFile(filepath.Join(dir, fmt.Sprintf("call.%d", index)))
	if err != nil {
		t.Fatal(err)
	}
	stdin, _ := os.ReadFile(filepath.Join(dir, fmt.Sprintf("prompt.%d", index)))
	return string(argv), string(stdin)
}

type agentEvent struct {
	Source  string `json:"source"`
	Type    string `json:"type"`
	Payload struct {
		Seq     int64   `json:"seq"`
		CostUSD float64 `json:"cost_usd"`
		Turns   int     `json:"turns"`
		Error   string  `json:"error"`
	} `json:"payload"`
}

func (d *daemon) agentEvents(hubID string) []agentEvent {
	var events []agentEvent
	for _, line := range strings.Split(strings.TrimSpace(d.mustRun("events", hubID)), "\n") {
		var event agentEvent
		if json.Unmarshal([]byte(line), &event) == nil && strings.HasPrefix(event.Type, "agent.") {
			events = append(events, event)
		}
	}
	return events
}

func emitSeq(d *daemon, hubID, eventType, payload string) int64 {
	var emitted struct {
		Seq int64 `json:"seq"`
	}
	json.Unmarshal([]byte(d.mustRun("emit", hubID, eventType, payload)), &emitted)
	return emitted.Seq
}

func TestCLIAgentResumesItsSessionAndReportsCost(t *testing.T) {
	calls := installFakeClaude(t)
	dataDirectory := t.TempDir()
	t.Setenv(envDataDir, dataDirectory)
	hub := startDaemonIn(t, dataDirectory)
	hub.mustRun("create", "h")
	hub.mustRun("agent", "add", "h", "oncall", "--on", "gate.approve", "--match", "step=promote",
		"--prompt", "Mark the promote step done", "--allow", "Bash(git:*)", "--budget", "0.50")

	firstSeq := emitSeq(hub, "h", "gate.approve", `{"step":"promote"}`)
	eventually(t, "first agent.done", func() bool { return len(hub.agentEvents("h")) == 1 })
	done := hub.agentEvents("h")[0]
	if done.Type != eventAgentDone || done.Source != "svc:oncall" || done.Payload.Seq != firstSeq ||
		done.Payload.CostUSD != 0.25 || done.Payload.Turns != 3 {
		t.Fatalf("agent.done = %+v", done)
	}
	args, prompt := readCall(t, calls, 0)
	for _, want := range []string{"-p\n", "--output-format\njson\n", "--setting-sources\nproject,local\n", "--strict-mcp-config\n", "--allowedTools\nRead,Grep,Glob,Bash(djt-hub:*),Bash(git:*)\n", "--max-budget-usd\n0.50\n", "daemon agent"} {
		if !strings.Contains(args, want) {
			t.Errorf("first call lacks %q:\n%s", want, args)
		}
	}
	if strings.Contains(args, "--resume") {
		t.Errorf("first call resumed a session:\n%s", args)
	}
	for _, want := range []string{"Mark the promote step done", `"step":"promote"`, `"id":"h"`} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt lacks %q:\n%s", want, prompt)
		}
	}

	emitSeq(hub, "h", "gate.approve", `{"step":"promote","note":"again"}`)
	eventually(t, "second agent.done", func() bool { return len(hub.agentEvents("h")) == 2 })
	if args, _ := readCall(t, calls, 1); !strings.Contains(args, "--resume\nsess-1\n") {
		t.Fatalf("second call did not resume sess-1:\n%s", args)
	}

	hub.mustRun("svc", "add", "h", "plain", "--every", "1h", "--", "true")
	if listed := hub.mustRun("agent", "ls", "h"); !strings.Contains(listed, `"oncall"`) || strings.Contains(listed, `"plain"`) {
		t.Fatalf("agent ls:\n%s", listed)
	}
	session := filepath.Join(dataDirectory, "agents", "h", "oncall.session")
	if _, err := os.Stat(session); err != nil {
		t.Fatalf("session file: %v", err)
	}
	hub.mustRun("agent", "reset", "h", "oncall")
	if _, err := os.Stat(session); !os.IsNotExist(err) {
		t.Fatalf("reset kept the session file: %v", err)
	}
}

func TestCLIAgentReportsClaudeErrorsAsFailed(t *testing.T) {
	installFakeClaude(t)
	dataDirectory := t.TempDir()
	t.Setenv(envDataDir, dataDirectory)
	hub := startDaemonIn(t, dataDirectory)
	hub.mustRun("create", "h")
	hub.mustRun("agent", "add", "h", "oncall", "--on", "action")

	seq := emitSeq(hub, "h", "action", `{"action":"boom"}`)
	eventually(t, "agent.failed", func() bool { return len(hub.agentEvents("h")) == 1 })
	failed := hub.agentEvents("h")[0]
	if failed.Type != eventAgentFailed || failed.Payload.Seq != seq || failed.Payload.Error != "error_max_budget_usd" {
		t.Fatalf("agent.failed = %+v", failed)
	}
	if exit := hub.mustRun("svc", "show", "h", "oncall"); strings.Contains(exit, `"last_exit": 1`) {
		t.Fatalf("agent run exited nonzero after reporting:\n%s", exit)
	}
}

func TestCLIAgentAddRejectsBadInput(t *testing.T) {
	hub := startDaemon(t)
	hub.mustRun("create", "h")
	for _, args := range [][]string{
		{"agent", "add", "h", "oncall"},
		{"agent", "add", "h", "oncall", "--on", "action", "--budget", "0"},
	} {
		if output, err := hub.run(args...); err == nil {
			t.Errorf("%v succeeded:\n%s", args, output)
		}
	}
}
