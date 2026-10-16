// Package supervisor runs hub services: long-lived processes restarted per
// policy, and scheduled jobs fired by --every or --cron. Each run is a shell
// command in its own process group, so stopping a service kills its children.
package supervisor

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/robfig/cron/v3"
	"github.com/tory37/djaunt-agent-hubs/internal/store"
)

const (
	StateStarting = "starting"
	StateRunning  = "running"
	StateWaiting  = "waiting"
	StateBackoff  = "backoff"
	StateStopped  = "stopped"
	StateExited   = "exited"
	StateFailed   = "failed"

	EventStarted = "svc.started"
	EventExited  = "svc.exited"
	EventFailed  = "svc.failed"

	stopGracePeriod   = 5 * time.Second
	stableRunDuration = 30 * time.Second
	maxLogBytes       = 5 << 20
)

// EventSink records a lifecycle event in the hub log and pushes it to viewers.
type EventSink func(ctx context.Context, hubID, source, eventType string, payload any)

type Config struct {
	Store       *store.Store
	LogDir      string
	HubAddress  string
	Events      EventSink
	MinBackoff  time.Duration
	MaxBackoff  time.Duration
	StopTimeout time.Duration
}

type Supervisor struct {
	config Config
	mu     sync.Mutex
	units  map[unitKey]*unit
}

type unitKey struct{ hubID, name string }

type unit struct {
	service    store.Service
	schedule   cron.Schedule
	generation int
	state      string
	process    *os.Process
	exited     chan struct{}
	timer      *time.Timer
	startedAt  time.Time
	nextRun    time.Time
	lastExit   *int
	lastError  string
	restarts   int
	failStreak int
}

type Status struct {
	store.Service
	State     string     `json:"state"`
	PID       int        `json:"pid,omitempty"`
	Restarts  int        `json:"restarts"`
	LastExit  *int       `json:"last_exit,omitempty"`
	LastError string     `json:"last_error,omitempty"`
	StartedAt *time.Time `json:"started_at,omitempty"`
	NextRun   *time.Time `json:"next_run,omitempty"`
	Log       string     `json:"log"`
}

func New(config Config) *Supervisor {
	if config.MinBackoff == 0 {
		config.MinBackoff = time.Second
	}
	if config.MaxBackoff == 0 {
		config.MaxBackoff = time.Minute
	}
	if config.StopTimeout == 0 {
		config.StopTimeout = stopGracePeriod
	}
	if config.Events == nil {
		config.Events = func(context.Context, string, string, string, any) {}
	}
	return &Supervisor{config: config, units: map[unitKey]*unit{}}
}

func ParseSchedule(service store.Service) (cron.Schedule, error) {
	if service.Cron == "" {
		return nil, nil
	}
	schedule, err := cron.ParseStandard(service.Cron)
	if err != nil {
		return nil, fmt.Errorf("%w: cron %q: %v", store.ErrInvalidInput, service.Cron, err)
	}
	return schedule, nil
}

// Restore starts every service that should be running in an active hub.
// The daemon calls it once at boot.
func (s *Supervisor) Restore(ctx context.Context) error {
	services, err := s.config.Store.ListRunnableServices(ctx)
	if err != nil {
		return err
	}
	for _, service := range services {
		schedule, err := ParseSchedule(service)
		if err != nil {
			continue
		}
		s.mu.Lock()
		s.startLocked(s.unitFor(service, schedule))
		s.mu.Unlock()
	}
	return nil
}

func (s *Supervisor) Add(ctx context.Context, service store.Service) (Status, error) {
	if service.Every > 0 && time.Duration(service.Every) < 100*time.Millisecond {
		return Status{}, fmt.Errorf("%w: every must be at least 100ms", store.ErrInvalidInput)
	}
	schedule, err := ParseSchedule(service)
	if err != nil {
		return Status{}, err
	}
	saved, err := s.config.Store.AddService(ctx, service)
	if err != nil {
		return Status{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.unitFor(saved, schedule)
	s.startLocked(current)
	return s.statusLocked(current), nil
}

func (s *Supervisor) Start(ctx context.Context, hubID, name string) (Status, error) {
	service, err := s.config.Store.GetService(ctx, hubID, name)
	if err != nil {
		return Status{}, err
	}
	schedule, err := ParseSchedule(service)
	if err != nil {
		return Status{}, err
	}
	if err := s.config.Store.SetServiceDesired(ctx, hubID, name, store.DesiredRunning); err != nil {
		return Status{}, err
	}
	service.Desired = store.DesiredRunning
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.unitFor(service, schedule)
	if current.process == nil && current.timer == nil {
		current.restarts = 0
		current.failStreak = 0
		s.startLocked(current)
	}
	return s.statusLocked(current), nil
}

func (s *Supervisor) Stop(ctx context.Context, hubID, name string) (Status, error) {
	if err := s.config.Store.SetServiceDesired(ctx, hubID, name, store.DesiredStopped); err != nil {
		return Status{}, err
	}
	s.halt(unitKey{hubID, name})
	return s.Get(ctx, hubID, name)
}

func (s *Supervisor) Remove(ctx context.Context, hubID, name string) error {
	if _, err := s.config.Store.GetService(ctx, hubID, name); err != nil {
		return err
	}
	s.halt(unitKey{hubID, name})
	s.mu.Lock()
	delete(s.units, unitKey{hubID, name})
	s.mu.Unlock()
	return s.config.Store.RemoveService(ctx, hubID, name)
}

// StopHub halts every service in a hub without changing desired state, so a
// closed hub's services stay recorded but do not run.
func (s *Supervisor) StopHub(hubID string) {
	s.mu.Lock()
	var keys []unitKey
	for key := range s.units {
		if key.hubID == hubID {
			keys = append(keys, key)
		}
	}
	s.mu.Unlock()
	s.haltAll(keys)
	s.mu.Lock()
	for _, key := range keys {
		delete(s.units, key)
	}
	s.mu.Unlock()
}

// Shutdown halts every service. Desired state is kept, so Restore relaunches
// them on the next boot.
func (s *Supervisor) Shutdown() {
	s.mu.Lock()
	keys := make([]unitKey, 0, len(s.units))
	for key := range s.units {
		keys = append(keys, key)
	}
	s.mu.Unlock()
	s.haltAll(keys)
}

func (s *Supervisor) haltAll(keys []unitKey) {
	var group sync.WaitGroup
	for _, key := range keys {
		group.Add(1)
		go func() {
			defer group.Done()
			s.halt(key)
		}()
	}
	group.Wait()
}

func (s *Supervisor) Get(ctx context.Context, hubID, name string) (Status, error) {
	service, err := s.config.Store.GetService(ctx, hubID, name)
	if err != nil {
		return Status{}, err
	}
	return s.statusFor(service), nil
}

func (s *Supervisor) List(ctx context.Context, hubID string) ([]Status, error) {
	services, err := s.config.Store.ListServices(ctx, hubID)
	if err != nil {
		return nil, err
	}
	statuses := make([]Status, 0, len(services))
	for _, service := range services {
		statuses = append(statuses, s.statusFor(service))
	}
	return statuses, nil
}

func (s *Supervisor) LogPath(hubID, name string) string {
	return filepath.Join(s.config.LogDir, hubID, name+".log")
}

func (s *Supervisor) statusFor(service store.Service) Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	if current, isKnown := s.units[unitKey{service.HubID, service.Name}]; isKnown {
		status := s.statusLocked(current)
		status.Service = service
		return status
	}
	return Status{Service: service, State: StateStopped, Log: s.LogPath(service.HubID, service.Name)}
}

func (s *Supervisor) statusLocked(current *unit) Status {
	status := Status{
		Service:   current.service,
		State:     current.state,
		Restarts:  current.restarts,
		LastExit:  current.lastExit,
		LastError: current.lastError,
		Log:       s.LogPath(current.service.HubID, current.service.Name),
	}
	if current.process != nil {
		status.PID = current.process.Pid
		startedAt := current.startedAt
		status.StartedAt = &startedAt
	}
	if current.timer != nil && !current.nextRun.IsZero() {
		nextRun := current.nextRun
		status.NextRun = &nextRun
	}
	return status
}

func (s *Supervisor) unitFor(service store.Service, schedule cron.Schedule) *unit {
	key := unitKey{service.HubID, service.Name}
	current, isKnown := s.units[key]
	if !isKnown {
		current = &unit{state: StateStopped}
		s.units[key] = current
	}
	current.service = service
	current.schedule = schedule
	return current
}

func (s *Supervisor) startLocked(current *unit) {
	current.generation++
	if !current.service.Scheduled() {
		s.launchLocked(current)
		return
	}
	if current.service.Every > 0 {
		s.launchLocked(current)
	}
	s.scheduleNextLocked(current)
}

func (s *Supervisor) scheduleNextLocked(current *unit) {
	now := time.Now()
	if current.service.Every > 0 {
		current.nextRun = now.Add(time.Duration(current.service.Every))
	} else {
		current.nextRun = current.schedule.Next(now)
	}
	if current.process == nil {
		current.state = StateWaiting
	}
	generation := current.generation
	current.timer = time.AfterFunc(time.Until(current.nextRun), func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if current.generation != generation {
			return
		}
		if current.process == nil {
			s.launchLocked(current)
		}
		s.scheduleNextLocked(current)
	})
}

func (s *Supervisor) launchLocked(current *unit) {
	service := current.service
	logFile, err := s.openLog(service)
	if err != nil {
		s.recordStartFailureLocked(current, err)
		return
	}
	command := exec.Command("/bin/sh", "-c", service.Command)
	command.Dir = service.Workdir
	command.Env = s.environment(service)
	command.Stdout = logFile
	command.Stderr = logFile
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	startedAt := time.Now()
	fmt.Fprintf(logFile, "--- %s start: %s\n", startedAt.Format(time.RFC3339), service.Command)
	if err := command.Start(); err != nil {
		fmt.Fprintf(logFile, "--- start failed: %v\n", err)
		logFile.Close()
		s.recordStartFailureLocked(current, err)
		return
	}

	current.process = command.Process
	current.exited = make(chan struct{})
	current.startedAt = startedAt
	current.state = StateRunning
	current.lastError = ""
	if !service.Scheduled() {
		s.emit(service, EventStarted, map[string]any{"pid": command.Process.Pid})
	}

	generation := current.generation
	exited := current.exited
	go func() {
		waitErr := command.Wait()
		exitCode := exitCodeOf(command, waitErr)
		ranFor := time.Since(startedAt)
		fmt.Fprintf(logFile, "--- %s exit %d after %s\n", time.Now().Format(time.RFC3339), exitCode, ranFor.Round(time.Millisecond))
		logFile.Close()
		s.mu.Lock()
		defer s.mu.Unlock()
		current.process = nil
		close(exited)
		s.afterExitLocked(current, generation, exitCode, ranFor)
	}()
}

func (s *Supervisor) recordStartFailureLocked(current *unit, err error) {
	current.state = StateFailed
	current.lastError = err.Error()
	s.emit(current.service, EventFailed, map[string]any{"error": err.Error()})
}

func (s *Supervisor) afterExitLocked(current *unit, generation, exitCode int, ranFor time.Duration) {
	current.lastExit = &exitCode
	if current.generation != generation {
		return
	}
	service := current.service
	payload := map[string]any{"code": exitCode, "duration_ms": ranFor.Milliseconds()}
	if service.Scheduled() {
		current.state = StateWaiting
		if exitCode != 0 {
			s.emit(service, EventFailed, payload)
		}
		return
	}

	s.emit(service, EventExited, payload)
	shouldRestart := service.Restart == store.RestartAlways ||
		(service.Restart == store.RestartOnFailure && exitCode != 0)
	if !shouldRestart {
		current.state = StateExited
		if exitCode != 0 {
			current.state = StateFailed
		}
		return
	}
	if ranFor >= stableRunDuration {
		current.failStreak = 0
	}
	delay := s.backoff(current.failStreak)
	current.failStreak++
	current.restarts++
	current.state = StateBackoff
	current.nextRun = time.Now().Add(delay)
	current.timer = time.AfterFunc(delay, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if current.generation != generation {
			return
		}
		current.timer = nil
		s.launchLocked(current)
	})
}

func (s *Supervisor) backoff(failStreak int) time.Duration {
	delay := s.config.MinBackoff
	for range failStreak {
		delay *= 2
		if delay >= s.config.MaxBackoff {
			return s.config.MaxBackoff
		}
	}
	return delay
}

// halt cancels pending timers and terminates the running process group:
// SIGTERM first, SIGKILL after the grace period.
func (s *Supervisor) halt(key unitKey) {
	s.mu.Lock()
	current, isKnown := s.units[key]
	if !isKnown {
		s.mu.Unlock()
		return
	}
	current.generation++
	if current.timer != nil {
		current.timer.Stop()
		current.timer = nil
	}
	process, exited := current.process, current.exited
	current.state = StateStopped
	s.mu.Unlock()

	if process == nil {
		return
	}
	syscall.Kill(-process.Pid, syscall.SIGTERM)
	select {
	case <-exited:
	case <-time.After(s.config.StopTimeout):
		syscall.Kill(-process.Pid, syscall.SIGKILL)
		<-exited
	}
}

func (s *Supervisor) emit(service store.Service, eventType string, payload map[string]any) {
	s.config.Events(context.Background(), service.HubID, "svc:"+service.Name, eventType, payload)
}

func (s *Supervisor) openLog(service store.Service) (*os.File, error) {
	path := s.LogPath(service.HubID, service.Name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	if info, err := os.Stat(path); err == nil && info.Size() > maxLogBytes {
		os.Rename(path, path+".1")
	}
	return os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
}

// environment puts the daemon's own directory first on PATH, so services can
// call djt-hub under launchd's minimal environment.
func (s *Supervisor) environment(service store.Service) []string {
	environment := os.Environ()
	if executable, err := os.Executable(); err == nil {
		environment = append(environment, "PATH="+filepath.Dir(executable)+string(os.PathListSeparator)+os.Getenv("PATH"))
	}
	for key, value := range service.Env {
		environment = append(environment, key+"="+value)
	}
	return append(environment,
		"DJT_HUB_ID="+service.HubID,
		"DJT_HUB_ADDR="+s.config.HubAddress,
		"DJT_SVC="+service.Name,
	)
}

func exitCodeOf(command *exec.Cmd, waitErr error) int {
	if waitErr == nil {
		return 0
	}
	var exitError *exec.ExitError
	if errors.As(waitErr, &exitError) {
		if status, isWaitStatus := exitError.Sys().(syscall.WaitStatus); isWaitStatus && status.Signaled() {
			return 128 + int(status.Signal())
		}
		return exitError.ExitCode()
	}
	if command.ProcessState != nil {
		return command.ProcessState.ExitCode()
	}
	return -1
}

// TailLines returns the last n lines of a log file, or all of it when n <= 0.
func TailLines(path string, n int) (string, int64, error) {
	content, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", 0, nil
	}
	if err != nil {
		return "", 0, err
	}
	size := int64(len(content))
	text := string(content)
	if n <= 0 {
		return text, size, nil
	}
	lines := strings.SplitAfter(text, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, ""), size, nil
}
