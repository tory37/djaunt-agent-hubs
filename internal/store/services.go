package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
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
}

func (service Service) Scheduled() bool { return service.Every > 0 || service.Cron != "" }

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
	switch service.Restart {
	case RestartNever, RestartOnFailure, RestartAlways:
	default:
		return fmt.Errorf("%w: restart %q must be never, on-failure, or always", ErrInvalidInput, service.Restart)
	}
	return nil
}

func (s *Store) AddService(ctx context.Context, service Service) (Service, error) {
	if service.Restart == "" {
		service.Restart = RestartOnFailure
	}
	if service.Env == nil {
		service.Env = map[string]string{}
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
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO services (hub_id, name, command, workdir, env, every_ms, cron, restart, desired, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		service.HubID, service.Name, service.Command, service.Workdir, string(encodedEnv),
		time.Duration(service.Every).Milliseconds(), service.Cron, service.Restart, service.Desired, s.nowMillis())
	if isUniqueViolation(err) {
		return Service{}, fmt.Errorf("%w: service %q", ErrExists, service.Name)
	}
	if err != nil {
		return Service{}, err
	}
	return s.GetService(ctx, service.HubID, service.Name)
}

const serviceColumns = `hub_id, name, command, workdir, env, every_ms, cron, restart, desired, created_at`

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
	var encodedEnv string
	var everyMillis, createdAt int64
	err := row.Scan(&service.HubID, &service.Name, &service.Command, &service.Workdir, &encodedEnv,
		&everyMillis, &service.Cron, &service.Restart, &service.Desired, &createdAt)
	if err != nil {
		return Service{}, err
	}
	if err := json.Unmarshal([]byte(encodedEnv), &service.Env); err != nil {
		return Service{}, fmt.Errorf("service %q env: %w", service.Name, err)
	}
	service.Every = Interval(time.Duration(everyMillis) * time.Millisecond)
	service.CreatedAt = time.UnixMilli(createdAt)
	return service, nil
}
