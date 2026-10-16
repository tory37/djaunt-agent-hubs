package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

var cliBinary string

func TestMain(m *testing.M) {
	buildDir, err := os.MkdirTemp("", "djt-hub-cli")
	if err != nil {
		panic(err)
	}
	cliBinary = filepath.Join(buildDir, "djt-hub")
	build := exec.Command("go", "build", "-o", cliBinary, ".")
	build.Stderr = os.Stderr
	if err := build.Run(); err != nil {
		panic(err)
	}
	exitCode := m.Run()
	os.RemoveAll(buildDir)
	os.Exit(exitCode)
}

type daemon struct {
	t       *testing.T
	address string
	stop    func()
}

func startDaemon(t *testing.T) *daemon { return startDaemonIn(t, t.TempDir()) }

func startDaemonIn(t *testing.T, dataDirectory string) *daemon {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	listener.Close()

	serve := exec.Command(cliBinary, "serve", "--addr", address, "--data", dataDirectory)
	if err := serve.Start(); err != nil {
		t.Fatal(err)
	}
	var stopOnce sync.Once
	stop := func() {
		stopOnce.Do(func() {
			serve.Process.Signal(os.Interrupt)
			serve.Wait()
		})
	}
	t.Cleanup(stop)

	hub := &daemon{t: t, address: address, stop: stop}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := hub.run("status"); err == nil {
			return hub
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("daemon never became healthy")
	return nil
}

func (d *daemon) command(args ...string) *exec.Cmd {
	command := exec.Command(cliBinary, args...)
	command.Env = append(os.Environ(), envAddress+"="+d.address, envHubID+"=", envServiceName+"=")
	return command
}

func (d *daemon) run(args ...string) (string, error) {
	output, err := d.command(args...).CombinedOutput()
	return string(output), err
}

func (d *daemon) mustRun(args ...string) string {
	d.t.Helper()
	output, err := d.run(args...)
	if err != nil {
		d.t.Fatalf("djt-hub %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return output
}

func TestCLIBuildsHubAndWaitsForGate(t *testing.T) {
	hub := startDaemon(t)
	hub.mustRun("create", "release-42", "--title", "Release 42")
	hub.mustRun("block", "add", "release-42", `{"id":"steps","type":"steps","bind":"release.steps"}`)
	hub.mustRun("patch", "release-42", `release.steps=[{"id":"tag","status":"done"},{"id":"deploy","status":"pending"}]`)
	hub.mustRun("patch", "release-42", "release.steps.deploy.status=running", "release.version=3.2")

	if got := strings.TrimSpace(hub.mustRun("get", "release-42", "release.steps.deploy.status")); got != `"running"` {
		t.Fatalf("get: %s", got)
	}
	if got := strings.TrimSpace(hub.mustRun("get", "release-42", "release.version")); got != "3.2" {
		t.Fatalf("number not parsed as JSON: %s", got)
	}

	wait := hub.command("wait", "release-42", "--type", "gate.approve", "--match", "step=deploy", "--timeout", "10s")
	waitOutput := &strings.Builder{}
	wait.Stdout = waitOutput
	if err := wait.Start(); err != nil {
		t.Fatal(err)
	}
	time.Sleep(200 * time.Millisecond)
	hub.mustRun("emit", "release-42", "gate.approve", `{"step":"deploy"}`)
	if err := wait.Wait(); err != nil {
		t.Fatalf("wait failed: %v", err)
	}
	if !strings.Contains(waitOutput.String(), `"step":"deploy"`) {
		t.Fatalf("wait output: %s", waitOutput)
	}
}

func TestCLIWaitTimeoutExitCode(t *testing.T) {
	hub := startDaemon(t)
	hub.mustRun("create", "h")
	_, err := hub.run("wait", "h", "--type", "never", "--timeout", "200ms")
	exitError, isExitError := err.(*exec.ExitError)
	if !isExitError || exitError.ExitCode() != exitWaitTimeout {
		t.Fatalf("want exit %d, got %v", exitWaitTimeout, err)
	}
}

func TestCLIFollowStreamsEventsAsNDJSON(t *testing.T) {
	hub := startDaemon(t)
	hub.mustRun("create", "h")
	hub.mustRun("emit", "h", "before")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	follow := exec.CommandContext(ctx, cliBinary, "events", "h", "--follow")
	follow.Env = hub.command().Env
	stdout, _ := follow.StdoutPipe()
	if err := follow.Start(); err != nil {
		t.Fatal(err)
	}
	defer follow.Process.Kill()

	lines := bufio.NewScanner(stdout)
	readEventType := func() string {
		if !lines.Scan() {
			t.Fatal("follow ended early")
		}
		var event struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(lines.Bytes(), &event); err != nil {
			t.Fatalf("not NDJSON: %q", lines.Text())
		}
		return event.Type
	}
	if got := readEventType(); got != "before" {
		t.Fatalf("want backlog event, got %s", got)
	}
	hub.mustRun("patch", "h", "ignored=1")
	hub.mustRun("emit", "h", "after")
	if got := readEventType(); got != "after" {
		t.Fatalf("want live event, got %s", got)
	}
}

func TestCLIServiceEnvSetsHubAndSource(t *testing.T) {
	hub := startDaemon(t)
	hub.mustRun("create", "h")

	emit := hub.command("emit", "tick", `{"n":1}`)
	emit.Env = append(emit.Env, envHubID+"=h", envServiceName+"=poller")
	if output, err := emit.CombinedOutput(); err != nil {
		t.Fatalf("emit via env: %v\n%s", err, output)
	}
	output := hub.mustRun("events", "h")
	if !strings.Contains(output, `"source":"svc:poller"`) {
		t.Fatalf("source not set from DJT_SVC: %s", output)
	}
}

func TestCLIRejectsNonLoopbackAddress(t *testing.T) {
	output, err := exec.Command(cliBinary, "serve", "--addr", "0.0.0.0:0", "--data", t.TempDir()).CombinedOutput()
	if err == nil || !strings.Contains(string(output), "loopback") {
		t.Fatalf("want loopback refusal, got %v: %s", err, output)
	}
}

func TestCLIUnknownCommand(t *testing.T) {
	_, err := exec.Command(cliBinary, "frobnicate").CombinedOutput()
	if exitError, isExitError := err.(*exec.ExitError); !isExitError || exitError.ExitCode() != exitUsage {
		t.Fatalf("want usage exit, got %v", err)
	}
}

type serviceStatus struct {
	State  string `json:"state"`
	PID    int    `json:"pid"`
	Cursor int64  `json:"cursor"`
}

func (d *daemon) service(hubID, name string) serviceStatus {
	d.t.Helper()
	var status serviceStatus
	if err := json.Unmarshal([]byte(d.mustRun("svc", "show", hubID, name)), &status); err != nil {
		d.t.Fatal(err)
	}
	return status
}

func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func processAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func TestCLIServicePushesIntoHubAndStopsOnClose(t *testing.T) {
	hub := startDaemon(t)
	hub.mustRun("create", "h")
	hub.mustRun("svc", "add", "h", "ticker", "--every", "200ms", "--", "djt-hub", "emit", "tick", `{"n":1}`)
	hub.mustRun("svc", "add", "h", "watcher", "--", "sleep 30")

	waitOutput := hub.mustRun("wait", "h", "--type", "tick", "--timeout", "10s")
	if !strings.Contains(waitOutput, `"source":"svc:ticker"`) {
		t.Fatalf("wait output: %s", waitOutput)
	}
	if logText := hub.mustRun("svc", "logs", "h", "ticker", "--tail", "5"); !strings.Contains(logText, "exit 0") {
		t.Fatalf("logs: %s", logText)
	}
	watcher := hub.service("h", "watcher")
	if watcher.State != "running" || watcher.PID == 0 {
		t.Fatalf("watcher: %+v", watcher)
	}

	hub.mustRun("close", "h")
	eventually(t, "watcher exit", func() bool { return !processAlive(watcher.PID) })
	if state := hub.service("h", "watcher").State; state != "stopped" {
		t.Fatalf("watcher after close = %s", state)
	}
	if _, err := hub.run("svc", "start", "h", "watcher"); err == nil {
		t.Fatal("start on an archived hub must fail")
	}
}

func TestCLIDaemonRestartRestoresServices(t *testing.T) {
	dataDirectory := t.TempDir()
	first := startDaemonIn(t, dataDirectory)
	first.mustRun("create", "h")
	first.mustRun("svc", "add", "h", "watcher", "--", "sleep 30")
	first.mustRun("svc", "add", "h", "parked", "--", "sleep 30")
	first.mustRun("svc", "stop", "h", "parked")
	before := first.service("h", "watcher")
	first.stop()
	if processAlive(before.PID) {
		t.Fatal("daemon shutdown left the service running")
	}

	second := startDaemonIn(t, dataDirectory)
	after := second.service("h", "watcher")
	if after.State != "running" || after.PID == before.PID {
		t.Fatalf("watcher after restart: %+v (before pid %d)", after, before.PID)
	}
	if state := second.service("h", "parked").State; state != "stopped" {
		t.Fatalf("parked after restart = %s", state)
	}
	second.mustRun("svc", "rm", "h", "watcher")
	eventually(t, "removed service exit", func() bool { return !processAlive(after.PID) })
}

func TestCLITriggerRunsOnClicksOnlyWhileNoAgentListens(t *testing.T) {
	hub := startDaemon(t)
	out := filepath.Join(t.TempDir(), "out")
	hub.mustRun("create", "h")
	hub.mustRun("svc", "add", "h", "fallback", "--on", "gate.approve", "--match", "step=promote", "--unattached",
		"--", "cat >> "+out+"; echo >> "+out)

	hub.mustRun("emit", "h", "gate.approve", `{"step":"build"}`)
	hub.mustRun("emit", "h", "gate.approve", `{"step":"promote"}`)
	eventually(t, "trigger run", func() bool {
		content, _ := os.ReadFile(out)
		return strings.Contains(string(content), `"step":"promote"`)
	})

	listener := hub.command("wait", "h", "--type", "never", "--timeout", "10s")
	if err := listener.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Process.Kill(); listener.Wait() })
	eventually(t, "hub attached", func() bool { return strings.Contains(hub.mustRun("show", "h"), `"attached": true`) })

	var emitted struct {
		Seq int64 `json:"seq"`
	}
	json.Unmarshal([]byte(hub.mustRun("emit", "h", "gate.approve", `{"step":"promote","note":"live"}`)), &emitted)
	eventually(t, "skip advances cursor", func() bool { return hub.service("h", "fallback").Cursor == emitted.Seq })
	if content, _ := os.ReadFile(out); strings.Contains(string(content), "live") {
		t.Fatalf("trigger ran while an agent listened:\n%s", content)
	}
}
