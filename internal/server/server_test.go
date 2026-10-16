package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/tory37/djaunt-agent-hubs/internal/client"
	"github.com/tory37/djaunt-agent-hubs/internal/server"
	"github.com/tory37/djaunt-agent-hubs/internal/store"
)

func startServer(t *testing.T) *client.Client {
	t.Helper()
	hubStore, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server.New(hubStore, nil))
	t.Cleanup(func() {
		httpServer.Close()
		hubStore.Close()
	})
	return client.New(httpServer.URL, "agent")
}

func mustDo(t *testing.T, hubClient *client.Client, method, path string, body any, out any) {
	t.Helper()
	if err := hubClient.Do(context.Background(), method, path, body, out); err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
}

func TestFlatBlockBodyBecomesProps(t *testing.T) {
	hubClient := startServer(t)
	mustDo(t, hubClient, http.MethodPost, "/api/hubs", map[string]string{"id": "h"}, nil)
	mustDo(t, hubClient, http.MethodPost, client.HubPath("h", "blocks"),
		json.RawMessage(`{"id":"steps","type":"checklist","items":[{"id":"tag"}]}`), nil)

	var snapshot server.HubSnapshot
	mustDo(t, hubClient, http.MethodGet, client.HubPath("h"), nil, &snapshot)
	if len(snapshot.Blocks) != 1 || string(snapshot.Blocks[0].Props) != `{"items":[{"id":"tag"}]}` {
		t.Fatalf("unexpected blocks: %+v", snapshot.Blocks)
	}
}

func TestErrorStatusCodes(t *testing.T) {
	hubClient := startServer(t)
	mustDo(t, hubClient, http.MethodPost, "/api/hubs", map[string]string{"id": "h"}, nil)

	cases := []struct {
		name       string
		method     string
		path       string
		body       any
		wantStatus int
	}{
		{"duplicate hub", http.MethodPost, "/api/hubs", map[string]string{"id": "h"}, http.StatusConflict},
		{"missing hub", http.MethodGet, client.HubPath("nope"), nil, http.StatusNotFound},
		{"bad patch", http.MethodPatch, client.HubPath("h", "state"), json.RawMessage(`{}`), http.StatusBadRequest},
		{"missing state path", http.MethodGet, client.HubPath("h", "state") + "?path=a.b", nil, http.StatusNotFound},
	}
	for _, testCase := range cases {
		err := hubClient.Do(context.Background(), testCase.method, testCase.path, testCase.body, nil)
		var apiError *client.APIError
		if !errors.As(err, &apiError) || apiError.Status != testCase.wantStatus {
			t.Errorf("%s: want HTTP %d, got %v", testCase.name, testCase.wantStatus, err)
		}
	}
}

func TestWaitReturnsMatchingEventOnly(t *testing.T) {
	hubClient := startServer(t)
	mustDo(t, hubClient, http.MethodPost, "/api/hubs", map[string]string{"id": "h"}, nil)

	waitResult := make(chan json.RawMessage, 1)
	waitError := make(chan error, 1)
	go func() {
		event, err := hubClient.Wait(context.Background(), "h", client.WaitOptions{
			Type: "gate.approve", Matchers: []string{"step=deploy"}, Timeout: "5s",
		})
		waitResult <- event
		waitError <- err
	}()
	time.Sleep(100 * time.Millisecond)

	emit := func(eventType, payload string) {
		mustDo(t, hubClient, http.MethodPost, client.HubPath("h", "events"),
			map[string]any{"type": eventType, "payload": json.RawMessage(payload)}, nil)
	}
	emit("gate.approve", `{"step":"tag"}`)
	emit("other", `{"step":"deploy"}`)
	emit("gate.approve", `{"step":"deploy"}`)

	if err := <-waitError; err != nil {
		t.Fatal(err)
	}
	var event store.Event
	json.Unmarshal(<-waitResult, &event)
	if event.Type != "gate.approve" || string(event.Payload) != `{"step":"deploy"}` || event.Source != "agent" {
		t.Fatalf("wrong event: %+v", event)
	}
}

func TestWaitIgnoresPastEventsByDefault(t *testing.T) {
	hubClient := startServer(t)
	mustDo(t, hubClient, http.MethodPost, "/api/hubs", map[string]string{"id": "h"}, nil)
	mustDo(t, hubClient, http.MethodPost, client.HubPath("h", "events"), map[string]any{"type": "done"}, nil)

	_, err := hubClient.Wait(context.Background(), "h", client.WaitOptions{Type: "done", Timeout: "200ms"})
	if !errors.Is(err, client.ErrWaitTimedOut) {
		t.Fatalf("want timeout, got %v", err)
	}
	_, err = hubClient.Wait(context.Background(), "h", client.WaitOptions{Type: "done", Since: "0", Timeout: "1s"})
	if err != nil {
		t.Fatalf("since=0 should see the past event: %v", err)
	}
}

func TestStreamReplaysBacklogThenLiveChanges(t *testing.T) {
	hubClient := startServer(t)
	mustDo(t, hubClient, http.MethodPost, "/api/hubs", map[string]string{"id": "h"}, nil)
	mustDo(t, hubClient, http.MethodPost, client.HubPath("h", "events"), map[string]any{"type": "first"}, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	received := make(chan client.StreamMessage, 16)
	go hubClient.Stream(ctx, "h", 0, "", func(message client.StreamMessage) { received <- message })

	next := func() client.StreamMessage {
		select {
		case message := <-received:
			return message
		case <-ctx.Done():
			t.Fatal("stream timed out")
			return client.StreamMessage{}
		}
	}
	if message := next(); message.Kind != server.MessageEvent || message.Seq != 1 {
		t.Fatalf("want backlog event seq 1, got %+v", message)
	}

	mustDo(t, hubClient, http.MethodPatch, client.HubPath("h", "state"),
		[]store.Patch{{Path: "ci", Value: "green"}}, nil)
	if message := next(); message.Kind != server.MessageState || string(message.Data) != `{"ci":"green"}` {
		t.Fatalf("want state message, got %+v", message)
	}

	mustDo(t, hubClient, http.MethodPost, client.HubPath("h", "close"), nil, nil)
	if message := next(); message.Kind != server.MessageHub {
		t.Fatalf("want hub message, got %+v", message)
	}
}

func TestCloseRunsHooksAndBlocksWrites(t *testing.T) {
	hubStore, err := store.Open(filepath.Join(t.TempDir(), "hub.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer hubStore.Close()
	hubServer := server.New(hubStore, nil)
	var closedHubs []string
	hubServer.OnHubClosed(func(ctx context.Context, hubID string) { closedHubs = append(closedHubs, hubID) })
	httpServer := httptest.NewServer(hubServer)
	defer httpServer.Close()
	hubClient := client.New(httpServer.URL, "agent")

	mustDo(t, hubClient, http.MethodPost, "/api/hubs", map[string]string{"id": "h"}, nil)
	mustDo(t, hubClient, http.MethodPost, client.HubPath("h", "close"), nil, nil)
	if len(closedHubs) != 1 || closedHubs[0] != "h" {
		t.Fatalf("hook not run: %v", closedHubs)
	}
	err = hubClient.Do(context.Background(), http.MethodPatch, client.HubPath("h", "state"),
		[]store.Patch{{Path: "a", Value: 1}}, nil)
	var apiError *client.APIError
	if !errors.As(err, &apiError) || apiError.Status != http.StatusConflict {
		t.Fatalf("want 409 on archived hub, got %v", err)
	}
}
