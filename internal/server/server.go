package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/tory37/djaunt-agent-hubs/internal/match"
	"github.com/tory37/djaunt-agent-hubs/internal/store"
	"github.com/tory37/djaunt-agent-hubs/internal/supervisor"
)

const (
	SourceHeader       = "X-Hub-Source"
	AgentHeader        = "X-Hub-Agent"
	defaultSource      = "agent"
	maxRequestBytes    = 4 << 20
	sseHeartbeat       = 25 * time.Second
	defaultWaitTimeout = 30 * time.Minute
)

type HubClosedHook func(ctx context.Context, hubID string)

type Server struct {
	store       *store.Store
	broker      *Broker
	mux         *http.ServeMux
	onHubClosed []HubClosedHook
	supervisor  *supervisor.Supervisor
	attachments *attachments
}

func New(hubStore *store.Store, webAssets http.Handler) *Server {
	server := &Server{
		store:       hubStore,
		broker:      NewBroker(),
		mux:         http.NewServeMux(),
		attachments: newAttachments(DefaultAttachGrace),
	}
	server.routes(webAssets)
	return server
}

func (s *Server) Broker() *Broker { return s.broker }

func (s *Server) OnHubClosed(hook HubClosedHook) { s.onHubClosed = append(s.onHubClosed, hook) }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) { s.mux.ServeHTTP(w, r) }

func (s *Server) routes(webAssets http.Handler) {
	s.mux.HandleFunc("GET /api/health", s.health)
	s.mux.HandleFunc("GET /api/hubs", s.listHubs)
	s.mux.HandleFunc("POST /api/hubs", s.createHub)
	s.mux.HandleFunc("GET /api/hubs/{hub}", s.getHub)
	s.mux.HandleFunc("DELETE /api/hubs/{hub}", s.deleteHub)
	s.mux.HandleFunc("POST /api/hubs/{hub}/close", s.closeHub)
	s.mux.HandleFunc("POST /api/hubs/{hub}/blocks", s.addBlock)
	s.mux.HandleFunc("PUT /api/hubs/{hub}/blocks/{block}", s.setBlock)
	s.mux.HandleFunc("DELETE /api/hubs/{hub}/blocks/{block}", s.removeBlock)
	s.mux.HandleFunc("GET /api/hubs/{hub}/state", s.getState)
	s.mux.HandleFunc("PATCH /api/hubs/{hub}/state", s.patchState)
	s.mux.HandleFunc("GET /api/hubs/{hub}/events", s.listEvents)
	s.mux.HandleFunc("POST /api/hubs/{hub}/events", s.emitEvent)
	s.mux.HandleFunc("GET /api/hubs/{hub}/stream", s.stream)
	s.mux.HandleFunc("GET /api/hubs/{hub}/wait", s.wait)
	s.serviceRoutes()
	if webAssets != nil {
		s.mux.Handle("/", webAssets)
	}
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) listHubs(w http.ResponseWriter, r *http.Request) {
	includeArchived := r.URL.Query().Get("all") == "1"
	hubs, err := s.store.ListHubs(r.Context(), includeArchived)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, hubs)
}

func (s *Server) createHub(w http.ResponseWriter, r *http.Request) {
	var request struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	}
	if err := readJSON(r, &request); err != nil {
		writeError(w, err)
		return
	}
	hub, err := s.store.CreateHub(r.Context(), request.ID, request.Title)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, hub)
}

type HubSnapshot struct {
	Hub      store.Hub      `json:"hub"`
	Blocks   []store.Block  `json:"blocks"`
	State    map[string]any `json:"state"`
	LastSeq  int64          `json:"last_seq"`
	Attached bool           `json:"attached"`
}

func (s *Server) snapshot(ctx context.Context, hubID string) (HubSnapshot, error) {
	hub, err := s.store.GetHub(ctx, hubID)
	if err != nil {
		return HubSnapshot{}, err
	}
	blocks, err := s.store.ListBlocks(ctx, hubID)
	if err != nil {
		return HubSnapshot{}, err
	}
	document, err := s.store.GetState(ctx, hubID)
	if err != nil {
		return HubSnapshot{}, err
	}
	lastSeq, err := s.store.LastEventSeq(ctx, hubID)
	if err != nil {
		return HubSnapshot{}, err
	}
	return HubSnapshot{Hub: hub, Blocks: blocks, State: document, LastSeq: lastSeq, Attached: s.Attached(hubID)}, nil
}

func (s *Server) getHub(w http.ResponseWriter, r *http.Request) {
	snapshot, err := s.snapshot(r.Context(), r.PathValue("hub"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

func (s *Server) closeHub(w http.ResponseWriter, r *http.Request) {
	hubID := r.PathValue("hub")
	if err := s.store.ArchiveHub(r.Context(), hubID); err != nil {
		writeError(w, err)
		return
	}
	for _, hook := range s.onHubClosed {
		hook(r.Context(), hubID)
	}
	s.publishHub(r.Context(), hubID)
	writeJSON(w, http.StatusOK, map[string]any{"closed": hubID})
}

func (s *Server) deleteHub(w http.ResponseWriter, r *http.Request) {
	hubID := r.PathValue("hub")
	for _, hook := range s.onHubClosed {
		hook(r.Context(), hubID)
	}
	if err := s.store.DeleteHub(r.Context(), hubID); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": hubID})
}

// Block bodies accept either {"id","type","props":{...}} or a flat form where
// every key besides id and type becomes a prop, which is easier for agents.
type blockRequest map[string]json.RawMessage

func (request blockRequest) toBlock(blockIDFromPath string) (store.Block, error) {
	var block store.Block
	if rawID, hasID := request["id"]; hasID {
		if err := json.Unmarshal(rawID, &block.ID); err != nil {
			return block, fmt.Errorf("%w: id must be a string", store.ErrInvalidInput)
		}
	}
	if blockIDFromPath != "" {
		block.ID = blockIDFromPath
	}
	if rawType, hasType := request["type"]; hasType {
		if err := json.Unmarshal(rawType, &block.Type); err != nil {
			return block, fmt.Errorf("%w: type must be a string", store.ErrInvalidInput)
		}
	}
	if rawProps, hasProps := request["props"]; hasProps {
		block.Props = rawProps
		return block, nil
	}
	flatProps := map[string]json.RawMessage{}
	for key, value := range request {
		if key != "id" && key != "type" {
			flatProps[key] = value
		}
	}
	encoded, err := json.Marshal(flatProps)
	block.Props = encoded
	return block, err
}

func (s *Server) addBlock(w http.ResponseWriter, r *http.Request) {
	s.writeBlock(w, r, "", s.store.AddBlock, http.StatusCreated)
}

func (s *Server) setBlock(w http.ResponseWriter, r *http.Request) {
	s.writeBlock(w, r, r.PathValue("block"), s.store.SetBlock, http.StatusOK)
}

type blockWriter func(ctx context.Context, hubID string, block store.Block) (store.Block, error)

func (s *Server) writeBlock(w http.ResponseWriter, r *http.Request, blockIDFromPath string, write blockWriter, successStatus int) {
	hubID := r.PathValue("hub")
	var request blockRequest
	if err := readJSON(r, &request); err != nil {
		writeError(w, err)
		return
	}
	block, err := request.toBlock(blockIDFromPath)
	if err != nil {
		writeError(w, err)
		return
	}
	saved, err := write(r.Context(), hubID, block)
	if err != nil {
		writeError(w, err)
		return
	}
	s.publishBlocks(r.Context(), hubID)
	writeJSON(w, successStatus, saved)
}

func (s *Server) removeBlock(w http.ResponseWriter, r *http.Request) {
	hubID := r.PathValue("hub")
	if err := s.store.RemoveBlock(r.Context(), hubID, r.PathValue("block")); err != nil {
		writeError(w, err)
		return
	}
	s.publishBlocks(r.Context(), hubID)
	writeJSON(w, http.StatusOK, map[string]any{"removed": r.PathValue("block")})
}

func (s *Server) getState(w http.ResponseWriter, r *http.Request) {
	document, err := s.store.GetState(r.Context(), r.PathValue("hub"))
	if err != nil {
		writeError(w, err)
		return
	}
	path := r.URL.Query().Get("path")
	if path == "" {
		writeJSON(w, http.StatusOK, document)
		return
	}
	value, err := stateValue(document, path)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, value)
}

func (s *Server) patchState(w http.ResponseWriter, r *http.Request) {
	hubID := r.PathValue("hub")
	var patches []store.Patch
	if err := readJSON(r, &patches); err != nil {
		writeError(w, err)
		return
	}
	document, err := s.store.PatchState(r.Context(), hubID, patches)
	if err != nil {
		writeError(w, err)
		return
	}
	s.publish(hubID, MessageState, 0, document)
	writeJSON(w, http.StatusOK, document)
}

func (s *Server) listEvents(w http.ResponseWriter, r *http.Request) {
	filter, err := eventFilterFromQuery(r)
	if err != nil {
		writeError(w, err)
		return
	}
	events, err := s.store.ListEvents(r.Context(), r.PathValue("hub"), filter)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, events)
}

func (s *Server) emitEvent(w http.ResponseWriter, r *http.Request) {
	hubID := r.PathValue("hub")
	var request struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := readJSON(r, &request); err != nil {
		writeError(w, err)
		return
	}
	source := r.Header.Get(SourceHeader)
	if source == "" {
		source = defaultSource
	}
	event, err := s.recordEvent(r.Context(), hubID, source, request.Type, request.Payload)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, event)
}

// stream is an SSE feed. It replays logged events after ?since, then sends
// live events, block lists, state documents, and hub status changes.
func (s *Server) stream(w http.ResponseWriter, r *http.Request) {
	hubID := r.PathValue("hub")
	filter, err := eventFilterFromQuery(r)
	if err != nil {
		writeError(w, err)
		return
	}
	if _, err := s.store.GetHub(r.Context(), hubID); err != nil {
		writeError(w, err)
		return
	}
	flusher, canFlush := w.(http.Flusher)
	if !canFlush {
		writeError(w, errors.New("streaming unsupported"))
		return
	}

	live, unsubscribe := s.broker.Subscribe(hubID)
	defer unsubscribe()
	defer s.attach(r, hubID)()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	lastSentSeq := filter.AfterSeq
	backlogFilter := filter
	backlogFilter.Limit = defaultEventPage
	for {
		backlogFilter.AfterSeq = lastSentSeq
		backlog, err := s.store.ListEvents(r.Context(), hubID, backlogFilter)
		if err != nil {
			return
		}
		for _, event := range backlog {
			writeSSE(w, MessageEvent, event.Seq, event)
			lastSentSeq = event.Seq
		}
		if len(backlog) < defaultEventPage {
			break
		}
	}
	flusher.Flush()

	heartbeat := time.NewTicker(sseHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		case message, isOpen := <-live:
			if !isOpen {
				return
			}
			if message.Kind == MessageEvent {
				isAlreadySent := message.Seq <= lastSentSeq
				if isAlreadySent || !eventMatchesType(message, filter.Type) {
					continue
				}
				lastSentSeq = message.Seq
			}
			writeSSERaw(w, message.Kind, message.Seq, message.Data)
			flusher.Flush()
		}
	}
}

// wait blocks until an event matching ?type and every ?match=key=value arrives
// after ?since (default: now). It re-queries the log on each live event, so a
// dropped subscription never loses a match.
func (s *Server) wait(w http.ResponseWriter, r *http.Request) {
	hubID := r.PathValue("hub")
	query := r.URL.Query()
	matchers, err := match.Parse(query["match"])
	if err != nil {
		writeError(w, fmt.Errorf("%w: %v", store.ErrInvalidInput, err))
		return
	}
	timeout := defaultWaitTimeout
	if rawTimeout := query.Get("timeout"); rawTimeout != "" {
		timeout, err = time.ParseDuration(rawTimeout)
		if err != nil {
			writeError(w, fmt.Errorf("%w: timeout: %v", store.ErrInvalidInput, err))
			return
		}
	}

	live, unsubscribe := s.broker.Subscribe(hubID)
	defer func() { unsubscribe() }()
	defer s.attach(r, hubID)()

	afterSeq, err := s.store.LastEventSeq(r.Context(), hubID)
	if err != nil {
		writeError(w, err)
		return
	}
	if rawSince := query.Get("since"); rawSince != "" {
		afterSeq, err = strconv.ParseInt(rawSince, 10, 64)
		if err != nil {
			writeError(w, fmt.Errorf("%w: since must be an integer", store.ErrInvalidInput))
			return
		}
	}
	filter := store.EventFilter{AfterSeq: afterSeq, Type: query.Get("type")}

	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for {
		events, err := s.store.ListEvents(r.Context(), hubID, filter)
		if err != nil {
			writeError(w, err)
			return
		}
		for _, event := range events {
			if match.Payload(event.Payload, matchers) {
				writeJSON(w, http.StatusOK, event)
				return
			}
			filter.AfterSeq = event.Seq
		}

		select {
		case <-r.Context().Done():
			return
		case <-deadline.C:
			writeJSON(w, http.StatusRequestTimeout, map[string]any{"error": "timed out waiting for event"})
			return
		case _, isOpen := <-live:
			if !isOpen {
				live, unsubscribe = s.broker.Subscribe(hubID)
			}
		}
	}
}

func (s *Server) publish(hubID, kind string, seq int64, data any) {
	encoded, err := json.Marshal(data)
	if err != nil {
		return
	}
	s.broker.Publish(hubID, Message{Kind: kind, Seq: seq, Data: encoded})
}

func (s *Server) publishBlocks(ctx context.Context, hubID string) {
	blocks, err := s.store.ListBlocks(ctx, hubID)
	if err == nil {
		s.publish(hubID, MessageBlocks, 0, blocks)
	}
}

func (s *Server) publishHub(ctx context.Context, hubID string) {
	hub, err := s.store.GetHub(ctx, hubID)
	if err == nil {
		s.publish(hubID, MessageHub, 0, hub)
	}
}

const defaultEventPage = 1000

func eventFilterFromQuery(r *http.Request) (store.EventFilter, error) {
	query := r.URL.Query()
	filter := store.EventFilter{Type: query.Get("type"), Limit: defaultEventPage}
	if rawSince := query.Get("since"); rawSince != "" {
		since, err := strconv.ParseInt(rawSince, 10, 64)
		if err != nil {
			return filter, fmt.Errorf("%w: since must be an integer", store.ErrInvalidInput)
		}
		filter.AfterSeq = since
	}
	if rawLimit := query.Get("limit"); rawLimit != "" {
		limit, err := strconv.Atoi(rawLimit)
		if err != nil {
			return filter, fmt.Errorf("%w: limit must be an integer", store.ErrInvalidInput)
		}
		filter.Limit = limit
	}
	return filter, nil
}

func eventMatchesType(message Message, wantedType string) bool {
	if wantedType == "" {
		return true
	}
	var event struct {
		Type string `json:"type"`
	}
	json.Unmarshal(message.Data, &event)
	return event.Type == wantedType
}

func readJSON(r *http.Request, target any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes))
	if err != nil {
		return err
	}
	if err := json.Unmarshal(body, target); err != nil {
		return fmt.Errorf("%w: body: %v", store.ErrInvalidInput, err)
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	switch {
	case errors.Is(err, store.ErrNotFound):
		status = http.StatusNotFound
	case errors.Is(err, store.ErrExists), errors.Is(err, store.ErrHubArchived):
		status = http.StatusConflict
	case errors.Is(err, store.ErrInvalidInput):
		status = http.StatusBadRequest
	}
	writeJSON(w, status, map[string]any{"error": err.Error()})
}

func writeSSE(w io.Writer, kind string, seq int64, data any) {
	encoded, err := json.Marshal(data)
	if err != nil {
		return
	}
	writeSSERaw(w, kind, seq, encoded)
}

func writeSSERaw(w io.Writer, kind string, seq int64, data json.RawMessage) {
	if seq > 0 {
		fmt.Fprintf(w, "id: %d\n", seq)
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", kind, data)
}
