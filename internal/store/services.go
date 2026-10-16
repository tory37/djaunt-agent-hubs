package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/tory37/djaunt-agent-hubs/internal/match"
)

const (
	RestartNever     = "never"
	RestartOnFailure = "on-failure"
	RestartAlways    = "always"

	DesiredRunning = "running"
	DesiredStopped = "stopped"
)

type Service struct {
	HubID     string            `json:"hub"`
	Name      string            `json:"name"`
	Command   string            `json:"command"`
	Workdir   string            `json:"workdir"`
	Env       map[string]string `json:"env"`
	Every     Interval          `json:"every,omitempty"`
	Cron      string            `json:"cron,omitempty"`
	Restart   string            `json:"restart"`
	Desired   string            `json:"desired"`
	CreatedAt time.Time         `json:"created_at"`

	OnType     string   `json:"on,omitempty"`
	OnMatch    []string `json:"match,omitempty"`
	Unattached bool     `json:"unattached,omitempty"`
	CursorSeq  int64    `json:"cursor,omitempty"`
}

func (service Service) Scheduled() bool { return service.Every > 0 || service.Cron != "" }

// Triggered services run once per matching event instead of on a schedule.
func (service Service) Triggered() bool { return service.OnType != "" }

// Interval is a duration that reads as "30s" in JSON.
type Interval time.Duration

func (interval Interval) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Duration(interval).String())
}

func validateService(service Service) error {
	if err := ValidateIdentifier("service name", service.Name); err != nil {
		return err
	}
	if service.Command == "" {
		return fmt.Errorf("%w: service command is required", ErrInvalidInput)
	}
	if service.Every > 0 && service.Cron != "" {
		return fmt.Errorf("%w: set every or cron, not both", ErrInvalidInput)
	}
	if service.Triggered() && service.Scheduled() {
		return fmt.Errorf("%w: set on or a schedule, not both", ErrInvalidInput)
	}
	if service.Triggered() && service.Restart != RestartNever {
		return fmt.Errorf("%w: a triggered service runs once per event; restart must be never", ErrInvalidInput)
	}
	if !service.Triggered() && (service.Unattached || len(service.OnMatch) > 0) {
		return fmt.Errorf("%w: match and unattached need on", ErrInvalidInput)
	}
	if _, err := match.Parse(service.OnMatch); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	switch service.Restart {
	case RestartNever, RestartOnFailure, RestartAlways:
	default:
		return fmt.Errorf("%w: restart %q must be never, on-failure, or always", ErrInvalidInput, service.Restart)
	}
	return nil
}

// AddService saves a service as desired running. A triggered service starts
// its cursor at the hub's latest event, so it reacts only to new events.
func (s *Store) AddService(ctx context.Context, service Service) (Service, error) {
	if service.Restart == "" {
		service.Restart = RestartOnFailure
		if service.Triggered() {
			service.Restart = RestartNever
		}
	}
	if service.Env == nil {
		service.Env = map[string]string{}
	}
	if service.OnMatch == nil {
		service.OnMatch = []string{}
	}
	service.Desired = DesiredRunning
	if err := validateService(service); err != nil {
		return Service{}, err
	}
	if _, err := s.requireActiveHub(ctx, s.db, service.HubID); err != nil {
		return Service{}, err
	}
	encodedEnv, err := json.Marshal(service.Env)
	if err != nil {
		return Service{}, err
	}
	encodedMatch, err := json.Marshal(service.OnMatch)
	if err != nil {
		return Service{}, err
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO services (hub_id, name, command, workdir, env, every_ms, cron, restart, desired, created_at,
		                       on_type, on_match, unattached, cursor_seq)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
		         (SELECT COALESCE(MAX(seq), 0) FROM events WHERE hub_id = ?))`,
		service.HubID, service.Name, service.Command, service.Workdir, string(encodedEnv),
		time.Duration(service.Every).Milliseconds(), service.Cron, service.Restart, service.Desired, s.nowMillis(),
		service.OnType, string(encodedMatch), service.Unattached, service.HubID)
	if isUniqueViolation(err) {
		return Service{}, fmt.Errorf("%w: service %q", ErrExists, service.Name)
	}
	if err != nil {
		return Service{}, err
	}
	return s.GetService(ctx, service.HubID, service.Name)
}

const serviceColumns = `hub_id, name, command, workdir, env, every_ms, cron, restart, desired, created_at,
	on_type, on_match, unattached, cursor_seq`

func (s *Store) GetService(ctx context.Context, hubID, name string) (Service, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT `+serviceColumns+` FROM services WHERE hub_id = ? AND name = ?`, hubID, name)
	service, err := scanService(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Service{}, fmt.Errorf("%w: service %q in hub %q", ErrNotFound, name, hubID)
	}
	return service, err
}

func (s *Store) ListServices(ctx context.Context, hubID string) ([]Service, error) {
	if _, err := s.GetHub(ctx, hubID); err != nil {
		return nil, err
	}
	return s.queryServices(ctx,
		`SELECT `+serviceColumns+` FROM services WHERE hub_id = ? ORDER BY created_at, name`, hubID)
}

// ListRunnableServices returns the services to restart when the daemon boots:
// desired running, in hubs that are still active.
func (s *Store) ListRunnableServices(ctx context.Context) ([]Service, error) {
	return s.queryServices(ctx,
		`SELECT `+serviceColumns+` FROM services
		 WHERE desired = ? AND hub_id IN (SELECT id FROM hubs WHERE status = ?)
		 ORDER BY hub_id, created_at`, DesiredRunning, HubActive)
}

func (s *Store) SetServiceDesired(ctx context.Context, hubID, name, desired string) error {
	if desired == DesiredRunning {
		if _, err := s.requireActiveHub(ctx, s.db, hubID); err != nil {
			return err
		}
	}
	result, err := s.db.ExecContext(ctx,
		`UPDATE services SET desired = ? WHERE hub_id = ? AND name = ?`, desired, hubID, name)
	if err != nil {
		return err
	}
	return requireAffected(result, "service", name)
}

// SetServiceCursor records the last event seq a triggered service handled.
func (s *Store) SetServiceCursor(ctx context.Context, hubID, name string, seq int64) error {
	result, err := s.db.ExecContext(ctx,
		`UPDATE services SET cursor_seq = ? WHERE hub_id = ? AND name = ?`, seq, hubID, name)
	if err != nil {
		return err
	}
	return requireAffected(result, "service", name)
}

func (s *Store) RemoveService(ctx context.Context, hubID, name string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM services WHERE hub_id = ? AND name = ?`, hubID, name)
	if err != nil {
		return err
	}
	return requireAffected(result, "service", name)
}

func (s *Store) queryServices(ctx context.Context, query string, args ...any) ([]Service, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	services := []Service{}
	for rows.Next() {
		service, err := scanService(rows)
		if err != nil {
			return nil, err
		}
		services = append(services, service)
	}
	return services, rows.Err()
}

func scanService(row rowScanner) (Service, error) {
	var service Service
	var encodedEnv, encodedMatch string
	var everyMillis, createdAt int64
	err := row.Scan(&service.HubID, &service.Name, &service.Command, &service.Workdir, &encodedEnv,
		&everyMillis, &service.Cron, &service.Restart, &service.Desired, &createdAt,
		&service.OnType, &encodedMatch, &service.Unattached, &service.CursorSeq)
	if err != nil {
		return Service{}, err
	}
	if err := json.Unmarshal([]byte(encodedEnv), &service.Env); err != nil {
		return Service{}, fmt.Errorf("service %q env: %w", service.Name, err)
	}
	if err := json.Unmarshal([]byte(encodedMatch), &service.OnMatch); err != nil {
		return Service{}, fmt.Errorf("service %q match: %w", service.Name, err)
	}
	service.Every = Interval(time.Duration(everyMillis) * time.Millisecond)
	service.CreatedAt = time.UnixMilli(createdAt)
	return service, nil
}
