package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/tory37/djaunt-agent-hubs/internal/state"
	_ "modernc.org/sqlite"
)

var (
	ErrNotFound     = errors.New("not found")
	ErrExists       = errors.New("already exists")
	ErrHubArchived  = errors.New("hub is archived")
	ErrInvalidInput = errors.New("invalid input")
)

const (
	HubActive   = "active"
	HubArchived = "archived"
)

var identifierPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)

type Hub struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Block struct {
	ID       string          `json:"id"`
	Type     string          `json:"type"`
	Position int             `json:"position"`
	Props    json.RawMessage `json:"props"`
}

type Event struct {
	Seq       int64           `json:"seq"`
	HubID     string          `json:"hub"`
	Source    string          `json:"source"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"ts"`
}

type Patch struct {
	Path  string `json:"path"`
	Value any    `json:"value"`
}

type Store struct {
	db  *sql.DB
	now func() time.Time
}

func Open(databasePath string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(databasePath), 0o755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	dsn := "file:" + databasePath +
		"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	// One connection serializes writes, which keeps SQLite free of lock errors
	// and is plenty for a single-user local daemon.
	db.SetMaxOpenConns(1)
	store := &Store{db: db, now: time.Now}
	if err := store.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	var currentVersion int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&currentVersion); err != nil {
		return err
	}
	for version := currentVersion; version < len(migrations); version++ {
		if err := s.applyMigration(version); err != nil {
			return fmt.Errorf("migrate schema to v%d: %w", version+1, err)
		}
	}
	return nil
}

func (s *Store) applyMigration(fromVersion int) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(migrations[fromVersion]); err != nil {
		return err
	}
	if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, fromVersion+1)); err != nil {
		return err
	}
	return tx.Commit()
}

func ValidateIdentifier(kind, value string) error {
	if !identifierPattern.MatchString(value) {
		return fmt.Errorf("%w: %s %q must be lowercase letters, digits, - or _ (max 64)", ErrInvalidInput, kind, value)
	}
	return nil
}

func (s *Store) nowMillis() int64 { return s.now().UnixMilli() }

func (s *Store) CreateHub(ctx context.Context, id, title string) (Hub, error) {
	if err := ValidateIdentifier("hub id", id); err != nil {
		return Hub{}, err
	}
	if title == "" {
		title = id
	}
	createdAt := s.nowMillis()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Hub{}, err
	}
	defer tx.Rollback()

	_, err = tx.ExecContext(ctx,
		`INSERT INTO hubs (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
		id, title, HubActive, createdAt, createdAt)
	if isUniqueViolation(err) {
		return Hub{}, fmt.Errorf("%w: hub %q", ErrExists, id)
	}
	if err != nil {
		return Hub{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO hub_state (hub_id, document) VALUES (?, '{}')`, id); err != nil {
		return Hub{}, err
	}
	if err := tx.Commit(); err != nil {
		return Hub{}, err
	}
	return s.GetHub(ctx, id)
}

func (s *Store) GetHub(ctx context.Context, id string) (Hub, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT id, title, status, created_at, updated_at FROM hubs WHERE id = ?`, id)
	hub, err := scanHub(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Hub{}, fmt.Errorf("%w: hub %q", ErrNotFound, id)
	}
	return hub, err
}

func (s *Store) ListHubs(ctx context.Context, includeArchived bool) ([]Hub, error) {
	query := `SELECT id, title, status, created_at, updated_at FROM hubs`
	if !includeArchived {
		query += ` WHERE status = 'active'`
	}
	query += ` ORDER BY updated_at DESC`
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hubs := []Hub{}
	for rows.Next() {
		hub, err := scanHub(rows)
		if err != nil {
			return nil, err
		}
		hubs = append(hubs, hub)
	}
	return hubs, rows.Err()
}

func (s *Store) ArchiveHub(ctx context.Context, id string) error {
	if _, err := s.requireActiveHub(ctx, s.db, id); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx,
		`UPDATE hubs SET status = ?, updated_at = ? WHERE id = ?`, HubArchived, s.nowMillis(), id)
	return err
}

func (s *Store) DeleteHub(ctx context.Context, id string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM hubs WHERE id = ?`, id)
	if err != nil {
		return err
	}
	return requireAffected(result, "hub", id)
}

type queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func (s *Store) requireActiveHub(ctx context.Context, q queryer, id string) (Hub, error) {
	row := q.QueryRowContext(ctx,
		`SELECT id, title, status, created_at, updated_at FROM hubs WHERE id = ?`, id)
	hub, err := scanHub(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Hub{}, fmt.Errorf("%w: hub %q", ErrNotFound, id)
	}
	if err != nil {
		return Hub{}, err
	}
	if hub.Status == HubArchived {
		return Hub{}, fmt.Errorf("%w: %q", ErrHubArchived, id)
	}
	return hub, nil
}

func (s *Store) touchHub(ctx context.Context, tx *sql.Tx, id string) error {
	_, err := tx.ExecContext(ctx, `UPDATE hubs SET updated_at = ? WHERE id = ?`, s.nowMillis(), id)
	return err
}

// AddBlock appends a new block; SetBlock replaces an existing block's type and
// props in place, or appends it when missing.
func (s *Store) AddBlock(ctx context.Context, hubID string, block Block) (Block, error) {
	return s.writeBlock(ctx, hubID, block, false)
}

func (s *Store) SetBlock(ctx context.Context, hubID string, block Block) (Block, error) {
	return s.writeBlock(ctx, hubID, block, true)
}

func (s *Store) writeBlock(ctx context.Context, hubID string, block Block, allowReplace bool) (Block, error) {
	if err := ValidateIdentifier("block id", block.ID); err != nil {
		return Block{}, err
	}
	if block.Type == "" {
		return Block{}, fmt.Errorf("%w: block %q needs a type", ErrInvalidInput, block.ID)
	}
	props, err := normalizeJSONObject(block.Props)
	if err != nil {
		return Block{}, fmt.Errorf("%w: block %q props: %v", ErrInvalidInput, block.ID, err)
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Block{}, err
	}
	defer tx.Rollback()
	if _, err := s.requireActiveHub(ctx, tx, hubID); err != nil {
		return Block{}, err
	}

	var existingPosition int
	err = tx.QueryRowContext(ctx,
		`SELECT position FROM blocks WHERE hub_id = ? AND id = ?`, hubID, block.ID).Scan(&existingPosition)
	blockExists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Block{}, err
	}
	if blockExists && !allowReplace {
		return Block{}, fmt.Errorf("%w: block %q in hub %q", ErrExists, block.ID, hubID)
	}

	if blockExists {
		block.Position = existingPosition
		_, err = tx.ExecContext(ctx,
			`UPDATE blocks SET type = ?, props = ? WHERE hub_id = ? AND id = ?`,
			block.Type, string(props), hubID, block.ID)
	} else {
		err = tx.QueryRowContext(ctx,
			`SELECT COALESCE(MAX(position), -1) + 1 FROM blocks WHERE hub_id = ?`, hubID).Scan(&block.Position)
		if err == nil {
			_, err = tx.ExecContext(ctx,
				`INSERT INTO blocks (hub_id, id, type, position, props) VALUES (?, ?, ?, ?, ?)`,
				hubID, block.ID, block.Type, block.Position, string(props))
		}
	}
	if err != nil {
		return Block{}, err
	}
	if err := s.touchHub(ctx, tx, hubID); err != nil {
		return Block{}, err
	}
	if err := tx.Commit(); err != nil {
		return Block{}, err
	}
	block.Props = props
	return block, nil
}

func (s *Store) RemoveBlock(ctx context.Context, hubID, blockID string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := s.requireActiveHub(ctx, tx, hubID); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM blocks WHERE hub_id = ? AND id = ?`, hubID, blockID)
	if err != nil {
		return err
	}
	if err := requireAffected(result, "block", blockID); err != nil {
		return err
	}
	if err := s.touchHub(ctx, tx, hubID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ListBlocks(ctx context.Context, hubID string) ([]Block, error) {
	if _, err := s.GetHub(ctx, hubID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, type, position, props FROM blocks WHERE hub_id = ? ORDER BY position`, hubID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	blocks := []Block{}
	for rows.Next() {
		var block Block
		var props string
		if err := rows.Scan(&block.ID, &block.Type, &block.Position, &props); err != nil {
			return nil, err
		}
		block.Props = json.RawMessage(props)
		blocks = append(blocks, block)
	}
	return blocks, rows.Err()
}

func (s *Store) GetState(ctx context.Context, hubID string) (map[string]any, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT document FROM hub_state WHERE hub_id = ?`, hubID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: hub %q", ErrNotFound, hubID)
	}
	if err != nil {
		return nil, err
	}
	document := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		return nil, fmt.Errorf("corrupt state for hub %q: %w", hubID, err)
	}
	return document, nil
}

// PatchState applies every patch or none of them.
func (s *Store) PatchState(ctx context.Context, hubID string, patches []Patch) (map[string]any, error) {
	if len(patches) == 0 {
		return nil, fmt.Errorf("%w: no patches", ErrInvalidInput)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err := s.requireActiveHub(ctx, tx, hubID); err != nil {
		return nil, err
	}

	var raw string
	if err := tx.QueryRowContext(ctx, `SELECT document FROM hub_state WHERE hub_id = ?`, hubID).Scan(&raw); err != nil {
		return nil, err
	}
	document := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		return nil, fmt.Errorf("corrupt state for hub %q: %w", hubID, err)
	}
	for _, patch := range patches {
		if err := state.Set(document, patch.Path, patch.Value); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrInvalidInput, err)
		}
	}
	updated, err := json.Marshal(document)
	if err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE hub_state SET document = ? WHERE hub_id = ?`, string(updated), hubID); err != nil {
		return nil, err
	}
	if err := s.touchHub(ctx, tx, hubID); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return document, nil
}

// AppendEvent works on archived hubs too, so late service output and user
// clicks are never lost.
func (s *Store) AppendEvent(ctx context.Context, hubID, source, eventType string, payload json.RawMessage) (Event, error) {
	if source == "" || eventType == "" {
		return Event{}, fmt.Errorf("%w: event needs a source and a type", ErrInvalidInput)
	}
	normalizedPayload, err := normalizeJSONValue(payload)
	if err != nil {
		return Event{}, fmt.Errorf("%w: event payload: %v", ErrInvalidInput, err)
	}
	if _, err := s.GetHub(ctx, hubID); err != nil {
		return Event{}, err
	}
	createdAt := s.nowMillis()
	result, err := s.db.ExecContext(ctx,
		`INSERT INTO events (hub_id, source, type, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
		hubID, source, eventType, string(normalizedPayload), createdAt)
	if err != nil {
		return Event{}, err
	}
	seq, err := result.LastInsertId()
	if err != nil {
		return Event{}, err
	}
	return Event{
		Seq:       seq,
		HubID:     hubID,
		Source:    source,
		Type:      eventType,
		Payload:   normalizedPayload,
		CreatedAt: time.UnixMilli(createdAt),
	}, nil
}

type EventFilter struct {
	AfterSeq int64
	Type     string
	Limit    int
}

const defaultEventLimit = 1000

func (s *Store) ListEvents(ctx context.Context, hubID string, filter EventFilter) ([]Event, error) {
	if _, err := s.GetHub(ctx, hubID); err != nil {
		return nil, err
	}
	limit := filter.Limit
	if limit <= 0 {
		limit = defaultEventLimit
	}
	query := `SELECT seq, hub_id, source, type, payload, created_at FROM events WHERE hub_id = ? AND seq > ?`
	args := []any{hubID, filter.AfterSeq}
	if filter.Type != "" {
		query += ` AND type = ?`
		args = append(args, filter.Type)
	}
	query += ` ORDER BY seq LIMIT ?`
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []Event{}
	for rows.Next() {
		var event Event
		var payload string
		var createdAt int64
		if err := rows.Scan(&event.Seq, &event.HubID, &event.Source, &event.Type, &payload, &createdAt); err != nil {
			return nil, err
		}
		event.Payload = json.RawMessage(payload)
		event.CreatedAt = time.UnixMilli(createdAt)
		events = append(events, event)
	}
	return events, rows.Err()
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanHub(row rowScanner) (Hub, error) {
	var hub Hub
	var createdAt, updatedAt int64
	if err := row.Scan(&hub.ID, &hub.Title, &hub.Status, &createdAt, &updatedAt); err != nil {
		return Hub{}, err
	}
	hub.CreatedAt = time.UnixMilli(createdAt)
	hub.UpdatedAt = time.UnixMilli(updatedAt)
	return hub, nil
}

func requireAffected(result sql.Result, kind, id string) error {
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return fmt.Errorf("%w: %s %q", ErrNotFound, kind, id)
	}
	return nil
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

func normalizeJSONObject(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		return json.RawMessage(`{}`), nil
	}
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, fmt.Errorf("must be a JSON object: %w", err)
	}
	return json.Marshal(object)
}

func normalizeJSONValue(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		return json.RawMessage(`{}`), nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return json.Marshal(value)
}

func (s *Store) LastEventSeq(ctx context.Context, hubID string) (int64, error) {
	if _, err := s.GetHub(ctx, hubID); err != nil {
		return 0, err
	}
	var lastSeq int64
	err := s.db.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(seq), 0) FROM events WHERE hub_id = ?`, hubID).Scan(&lastSeq)
	return lastSeq, err
}
