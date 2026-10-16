package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	return store
}

func mustCreateHub(t *testing.T, store *Store, id string) {
	t.Helper()
	if _, err := store.CreateHub(context.Background(), id, "Release "+id); err != nil {
		t.Fatal(err)
	}
}

func TestCreateHubRejectsDuplicatesAndBadIDs(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	mustCreateHub(t, store, "release-42")

	if _, err := store.CreateHub(ctx, "release-42", ""); !errors.Is(err, ErrExists) {
		t.Fatalf("want ErrExists, got %v", err)
	}
	if _, err := store.CreateHub(ctx, "Bad ID", ""); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}
}

func TestReopenKeepsData(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "hub.db")
	first, err := Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := first.CreateHub(context.Background(), "persisted", ""); err != nil {
		t.Fatal(err)
	}
	first.Close()

	second, err := Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	if _, err := second.GetHub(context.Background(), "persisted"); err != nil {
		t.Fatalf("hub lost after reopen: %v", err)
	}
}

func TestOpenMigratesAV1DatabaseAndKeepsServices(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "hub.db")
	v1, err := sql.Open("sqlite", "file:"+databasePath)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		schemaV1,
		`PRAGMA user_version = 1`,
		`INSERT INTO hubs VALUES ('old', 'Old', 'active', 0, 0)`,
		`INSERT INTO services (hub_id, name, command, workdir, env, restart, desired, created_at)
		 VALUES ('old', 'watch', 'sleep 1', '/tmp', '{}', 'on-failure', 'running', 0)`,
	} {
		if _, err := v1.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	v1.Close()

	migrated, err := Open(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer migrated.Close()
	service, err := migrated.GetService(context.Background(), "old", "watch")
	if err != nil {
		t.Fatal(err)
	}
	if service.Triggered() || service.CursorSeq != 0 || len(service.OnMatch) != 0 || service.Command != "sleep 1" {
		t.Fatalf("migrated service = %+v", service)
	}
	var version int
	migrated.db.QueryRow(`PRAGMA user_version`).Scan(&version)
	if version != len(migrations) {
		t.Fatalf("user_version = %d, want %d", version, len(migrations))
	}
}

func TestTriggeredServiceStartsAtTheLatestEvent(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	mustCreateHub(t, store, "h")
	past, err := store.AppendEvent(ctx, "h", "user", "gate.approve", nil)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := store.AddService(ctx, Service{
		HubID: "h", Name: "gate", Command: "true", Workdir: "/tmp",
		OnType: "gate.approve", OnMatch: []string{"step=promote"}, Unattached: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if saved.CursorSeq != past.Seq || saved.Restart != RestartNever || !saved.Unattached || saved.OnMatch[0] != "step=promote" {
		t.Fatalf("saved = %+v", saved)
	}
	if err := store.SetServiceCursor(ctx, "h", "gate", 99); err != nil {
		t.Fatal(err)
	}
	if reloaded, _ := store.GetService(ctx, "h", "gate"); reloaded.CursorSeq != 99 {
		t.Fatalf("cursor = %d", reloaded.CursorSeq)
	}
}

func TestBlocksKeepOrderAndReplaceInPlace(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	mustCreateHub(t, store, "h")

	for _, id := range []string{"intro", "steps", "chart"} {
		if _, err := store.AddBlock(ctx, "h", Block{ID: id, Type: "markdown", Props: json.RawMessage(`{"text":"x"}`)}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.AddBlock(ctx, "h", Block{ID: "steps", Type: "markdown"}); !errors.Is(err, ErrExists) {
		t.Fatalf("want ErrExists on duplicate add, got %v", err)
	}
	if _, err := store.SetBlock(ctx, "h", Block{ID: "steps", Type: "steps", Props: json.RawMessage(`{"bind":"release"}`)}); err != nil {
		t.Fatal(err)
	}
	if err := store.RemoveBlock(ctx, "h", "intro"); err != nil {
		t.Fatal(err)
	}

	blocks, err := store.ListBlocks(ctx, "h")
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 2 || blocks[0].ID != "steps" || blocks[1].ID != "chart" {
		t.Fatalf("unexpected blocks: %+v", blocks)
	}
	if blocks[0].Type != "steps" || string(blocks[0].Props) != `{"bind":"release"}` {
		t.Fatalf("set did not replace block: %+v", blocks[0])
	}
}

func TestBlockPropsMustBeObject(t *testing.T) {
	store := openTestStore(t)
	mustCreateHub(t, store, "h")
	_, err := store.AddBlock(context.Background(), "h", Block{ID: "b", Type: "table", Props: json.RawMessage(`[1,2]`)})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}
}

func TestPatchStateIsAtomic(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	mustCreateHub(t, store, "h")

	if _, err := store.PatchState(ctx, "h", []Patch{{Path: "ci.status", Value: "green"}}); err != nil {
		t.Fatal(err)
	}
	_, err := store.PatchState(ctx, "h", []Patch{
		{Path: "ci.status", Value: "red"},
		{Path: "ci.status.nested", Value: 1.0},
	})
	if !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("want ErrInvalidInput, got %v", err)
	}

	document, err := store.GetState(ctx, "h")
	if err != nil {
		t.Fatal(err)
	}
	ci := document["ci"].(map[string]any)
	if ci["status"] != "green" {
		t.Fatalf("failed batch leaked a write: %v", document)
	}
}

func TestArchivedHubRejectsWritesButAcceptsEvents(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	mustCreateHub(t, store, "h")
	if err := store.ArchiveHub(ctx, "h"); err != nil {
		t.Fatal(err)
	}

	if _, err := store.PatchState(ctx, "h", []Patch{{Path: "a", Value: 1.0}}); !errors.Is(err, ErrHubArchived) {
		t.Fatalf("patch: want ErrHubArchived, got %v", err)
	}
	if _, err := store.AddBlock(ctx, "h", Block{ID: "b", Type: "markdown"}); !errors.Is(err, ErrHubArchived) {
		t.Fatalf("block: want ErrHubArchived, got %v", err)
	}
	if _, err := store.AppendEvent(ctx, "h", "user", "click", nil); err != nil {
		t.Fatalf("event on archived hub: %v", err)
	}

	activeHubs, _ := store.ListHubs(ctx, false)
	allHubs, _ := store.ListHubs(ctx, true)
	if len(activeHubs) != 0 || len(allHubs) != 1 {
		t.Fatalf("list filter wrong: active=%d all=%d", len(activeHubs), len(allHubs))
	}
}

func TestListEventsFiltersBySeqAndType(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	mustCreateHub(t, store, "h")

	first, _ := store.AppendEvent(ctx, "h", "user", "gate.approve", json.RawMessage(`{"step":"deploy"}`))
	store.AppendEvent(ctx, "h", "svc:ci", "ci.update", nil)
	store.AppendEvent(ctx, "h", "user", "gate.approve", json.RawMessage(`{"step":"verify"}`))

	events, err := store.ListEvents(ctx, "h", EventFilter{AfterSeq: first.Seq, Type: "gate.approve"})
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 || string(events[0].Payload) != `{"step":"verify"}` {
		t.Fatalf("unexpected events: %+v", events)
	}
}

func TestDeleteHubCascades(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	mustCreateHub(t, store, "h")
	store.AddBlock(ctx, "h", Block{ID: "b", Type: "markdown"})
	store.AppendEvent(ctx, "h", "agent", "note", nil)

	if err := store.DeleteHub(ctx, "h"); err != nil {
		t.Fatal(err)
	}
	var remainingRows int
	store.db.QueryRow(`SELECT (SELECT COUNT(*) FROM blocks) + (SELECT COUNT(*) FROM events) + (SELECT COUNT(*) FROM hub_state)`).Scan(&remainingRows)
	if remainingRows != 0 {
		t.Fatalf("cascade left %d rows", remainingRows)
	}
}
