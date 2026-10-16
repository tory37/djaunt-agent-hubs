package supervisor_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/tory37/djaunt-agent-hubs/internal/store"
	"github.com/tory37/djaunt-agent-hubs/internal/supervisor"
)

type recordedEvent struct{ hubID, source, eventType string }

type harness struct {
	t          *testing.T
	store      *store.Store
	dir        string
	mu         sync.Mutex
	events     []recordedEvent
	supervisor *supervisor.Supervisor
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	hubStore, err := store.Open(filepath.Join(dir, "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hubStore.CreateHub(context.Background(), "h", ""); err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, store: hubStore, dir: dir}
	h.supervisor = h.newSupervisor()
	t.Cleanup(func() {
		h.supervisor.Shutdown()
		hubStore.Close()
	})
	return h
}

func (h *harness) newSupervisor() *supervisor.Supervisor {
	return supervisor.New(supervisor.Config{
		Store:       h.store,
		LogDir:      filepath.Join(h.dir, "logs"),
		HubAddress:  "127.0.0.1:1",
		MinBackoff:  10 * time.Millisecond,
		MaxBackoff:  40 * time.Millisecond,
		StopTimeout: time.Second,
		Events: func(_ context.Context, hubID, source, eventType string, _ any) {
			h.mu.Lock()
			defer h.mu.Unlock()
			h.events = append(h.events, recordedEvent{hubID, source, eventType})
		},
	})
}

func (h *harness) add(service store.Service) supervisor.Status {
	h.t.Helper()
	service.HubID = "h"
	if service.Workdir == "" {
		service.Workdir = h.dir
	}
	status, err := h.supervisor.Add(context.Background(), service)
	if err != nil {
		h.t.Fatal(err)
	}
	return status
}

func (h *harness) status(name string) supervisor.Status {
	h.t.Helper()
	status, err := h.supervisor.Get(context.Background(), "h", name)
	if err != nil {
		h.t.Fatal(err)
	}
	return status
}

func (h *harness) countEvents(eventType string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	count := 0
	for _, event := range h.events {
		if event.eventType == eventType {
			count++
		}
	}
	return count
}

func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func processAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func readPID(t *testing.T, path string) int {
	t.Helper()
	var pid int
	eventually(t, "pid file "+path, func() bool {
		content, err := os.ReadFile(path)
		if err != nil {
			return false
		}
		pid, err = strconv.Atoi(strings.TrimSpace(string(content)))
		return err == nil
	})
	return pid
}

func TestServiceGetsHubEnvironmentAndLogsOutput(t *testing.T) {
	h := newHarness(t)
	h.add(store.Service{
		Name:    "env",
		Command: `echo "hub=$DJT_HUB_ID svc=$DJT_SVC addr=$DJT_HUB_ADDR extra=$EXTRA"; echo oops >&2`,
		Env:     map[string]string{"EXTRA": "yes"},
		Restart: store.RestartNever,
	})
	eventually(t, "exit", func() bool { return h.status("env").State == supervisor.StateExited })

	logText, _, err := supervisor.TailLines(h.status("env").Log, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"hub=h svc=env addr=127.0.0.1:1 extra=yes", "oops", "exit 0"} {
		if !strings.Contains(logText, want) {
			t.Errorf("log missing %q:\n%s", want, logText)
		}
	}
	if h.countEvents(supervisor.EventStarted) != 1 || h.countEvents(supervisor.EventExited) != 1 {
		t.Errorf("started=%d exited=%d", h.countEvents(supervisor.EventStarted), h.countEvents(supervisor.EventExited))
	}
}

func TestStopKillsTheWholeProcessGroup(t *testing.T) {
	h := newHarness(t)
	pidFile := filepath.Join(h.dir, "child.pid")
	h.add(store.Service{Name: "tree", Command: "sleep 30 & echo $! > " + pidFile + "; wait"})
	childPID := readPID(t, pidFile)
	if h.status("tree").State != supervisor.StateRunning {
		t.Fatalf("state = %s", h.status("tree").State)
	}

	status, err := h.supervisor.Stop(context.Background(), "h", "tree")
	if err != nil {
		t.Fatal(err)
	}
	if status.State != supervisor.StateStopped || status.Desired != store.DesiredStopped {
		t.Fatalf("after stop: %+v", status)
	}
	eventually(t, "child exit", func() bool { return !processAlive(childPID) })
}

func TestOnFailureRestartsWithBackoff(t *testing.T) {
	h := newHarness(t)
	h.add(store.Service{Name: "flaky", Command: "exit 3", Restart: store.RestartOnFailure})
	eventually(t, "three restarts", func() bool { return h.status("flaky").Restarts >= 3 })
	if code := h.status("flaky").LastExit; code == nil || *code != 3 {
		t.Fatalf("last exit = %v", code)
	}
}

func TestRestartPolicyNeverAndCleanExit(t *testing.T) {
	h := newHarness(t)
	h.add(store.Service{Name: "fails", Command: "exit 3", Restart: store.RestartNever})
	h.add(store.Service{Name: "clean", Command: "true", Restart: store.RestartOnFailure})
	eventually(t, "fails settles", func() bool { return h.status("fails").State == supervisor.StateFailed })
	eventually(t, "clean settles", func() bool { return h.status("clean").State == supervisor.StateExited })
	time.Sleep(50 * time.Millisecond)
	if restarts := h.status("fails").Restarts + h.status("clean").Restarts; restarts != 0 {
		t.Fatalf("restarts = %d, want 0", restarts)
	}
}

func TestEveryRunsRepeatedlyAndReportsFailures(t *testing.T) {
	h := newHarness(t)
	ticks := filepath.Join(h.dir, "ticks")
	h.add(store.Service{Name: "tick", Command: "echo . >> " + ticks + "; exit 1", Every: store.Interval(100 * time.Millisecond)})
	eventually(t, "three ticks", func() bool {
		content, _ := os.ReadFile(ticks)
		return strings.Count(string(content), ".") >= 3
	})
	status := h.status("tick")
	if status.NextRun == nil || status.Every != store.Interval(100*time.Millisecond) {
		t.Fatalf("status = %+v", status)
	}
	if h.countEvents(supervisor.EventFailed) < 3 || h.countEvents(supervisor.EventStarted) != 0 {
		t.Fatalf("failed=%d started=%d", h.countEvents(supervisor.EventFailed), h.countEvents(supervisor.EventStarted))
	}
}

func TestCronWaitsForItsSchedule(t *testing.T) {
	h := newHarness(t)
	status := h.add(store.Service{Name: "nightly", Command: "true", Cron: "0 3 * * *"})
	if status.State != supervisor.StateWaiting || status.NextRun == nil || status.NextRun.Hour() != 3 {
		t.Fatalf("status = %+v", status)
	}
	_, err := h.supervisor.Add(context.Background(), store.Service{HubID: "h", Name: "bad", Command: "true", Cron: "nope"})
	if !errors.Is(err, store.ErrInvalidInput) {
		t.Fatalf("bad cron err = %v", err)
	}
}

func TestRestoreRelaunchesOnlyDesiredServicesInActiveHubs(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	h.add(store.Service{Name: "keep", Command: "sleep 30"})
	h.add(store.Service{Name: "parked", Command: "sleep 30"})
	if _, err := h.supervisor.Stop(ctx, "h", "parked"); err != nil {
		t.Fatal(err)
	}
	if _, err := h.store.CreateHub(ctx, "old", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := h.supervisor.Add(ctx, store.Service{HubID: "old", Name: "gone", Command: "sleep 30", Workdir: h.dir}); err != nil {
		t.Fatal(err)
	}
	h.supervisor.StopHub("old")
	if err := h.store.ArchiveHub(ctx, "old"); err != nil {
		t.Fatal(err)
	}
	h.supervisor.Shutdown()

	h.supervisor = h.newSupervisor()
	if err := h.supervisor.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	if state := h.status("keep").State; state != supervisor.StateRunning {
		t.Errorf("keep = %s, want running", state)
	}
	if state := h.status("parked").State; state != supervisor.StateStopped {
		t.Errorf("parked = %s, want stopped", state)
	}
	gone, err := h.supervisor.Get(ctx, "old", "gone")
	if err != nil || gone.State != supervisor.StateStopped {
		t.Errorf("gone = %+v, %v", gone, err)
	}
}

func TestStopHubHaltsItsServices(t *testing.T) {
	h := newHarness(t)
	running := h.add(store.Service{Name: "watch", Command: "sleep 30"})
	h.supervisor.StopHub("h")
	eventually(t, "process exit", func() bool { return !processAlive(running.PID) })
	if desired := h.status("watch").Desired; desired != store.DesiredRunning {
		t.Fatalf("desired = %s; StopHub must keep desired state", desired)
	}
}

func TestTailLines(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.log")
	os.WriteFile(path, []byte("a\nb\nc\n"), 0o644)
	text, size, err := supervisor.TailLines(path, 2)
	if err != nil || text != "b\nc\n" || size != 6 {
		t.Fatalf("got %q %d %v", text, size, err)
	}
	if text, _, _ := supervisor.TailLines(filepath.Join(t.TempDir(), "missing"), 5); text != "" {
		t.Fatalf("missing file text = %q", text)
	}
}
