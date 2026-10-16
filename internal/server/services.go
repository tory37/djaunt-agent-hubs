package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/tory37/djaunt-agent-hubs/internal/store"
	"github.com/tory37/djaunt-agent-hubs/internal/supervisor"
)

const (
	defaultLogTail   = 200
	logFollowPolling = 500 * time.Millisecond
)

var errNoSupervisor = errors.New("service supervisor is not running")

// AttachSupervisor enables the service routes and stops a hub's services when
// the hub is closed or deleted.
func (s *Server) AttachSupervisor(services *supervisor.Supervisor) {
	s.supervisor = services
	s.OnHubClosed(func(ctx context.Context, hubID string) { services.StopHub(hubID) })
}

// RecordEvent appends an event and pushes it to live viewers.
func (s *Server) RecordEvent(ctx context.Context, hubID, source, eventType string, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	event, err := s.store.AppendEvent(ctx, hubID, source, eventType, encoded)
	if err != nil {
		return
	}
	s.publish(hubID, MessageEvent, event.Seq, event)
}

func (s *Server) serviceRoutes() {
	s.mux.HandleFunc("GET /api/hubs/{hub}/services", s.withSupervisor(s.listServices))
	s.mux.HandleFunc("POST /api/hubs/{hub}/services", s.withSupervisor(s.addService))
	s.mux.HandleFunc("GET /api/hubs/{hub}/services/{svc}", s.withSupervisor(s.getService))
	s.mux.HandleFunc("DELETE /api/hubs/{hub}/services/{svc}", s.withSupervisor(s.removeService))
	s.mux.HandleFunc("POST /api/hubs/{hub}/services/{svc}/start", s.withSupervisor(s.startService))
	s.mux.HandleFunc("POST /api/hubs/{hub}/services/{svc}/stop", s.withSupervisor(s.stopService))
	s.mux.HandleFunc("GET /api/hubs/{hub}/services/{svc}/logs", s.withSupervisor(s.serviceLogs))
}

func (s *Server) withSupervisor(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.supervisor == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": errNoSupervisor.Error()})
			return
		}
		handler(w, r)
	}
}

func (s *Server) listServices(w http.ResponseWriter, r *http.Request) {
	statuses, err := s.supervisor.List(r.Context(), r.PathValue("hub"))
	respond(w, http.StatusOK, statuses, err)
}

func (s *Server) addService(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Name    string            `json:"name"`
		Command string            `json:"command"`
		Workdir string            `json:"workdir"`
		Env     map[string]string `json:"env"`
		Every   string            `json:"every"`
		Cron    string            `json:"cron"`
		Restart string            `json:"restart"`
	}
	if err := readJSON(r, &request); err != nil {
		writeError(w, err)
		return
	}
	service := store.Service{
		HubID:   r.PathValue("hub"),
		Name:    request.Name,
		Command: request.Command,
		Workdir: request.Workdir,
		Env:     request.Env,
		Cron:    request.Cron,
		Restart: request.Restart,
	}
	if request.Every != "" {
		every, err := time.ParseDuration(request.Every)
		if err != nil {
			writeError(w, fmt.Errorf("%w: every %q: %v", store.ErrInvalidInput, request.Every, err))
			return
		}
		service.Every = store.Interval(every)
	}
	status, err := s.supervisor.Add(r.Context(), service)
	respond(w, http.StatusCreated, status, err)
}

func (s *Server) getService(w http.ResponseWriter, r *http.Request) {
	status, err := s.supervisor.Get(r.Context(), r.PathValue("hub"), r.PathValue("svc"))
	respond(w, http.StatusOK, status, err)
}

func (s *Server) startService(w http.ResponseWriter, r *http.Request) {
	status, err := s.supervisor.Start(r.Context(), r.PathValue("hub"), r.PathValue("svc"))
	respond(w, http.StatusOK, status, err)
}

func (s *Server) stopService(w http.ResponseWriter, r *http.Request) {
	status, err := s.supervisor.Stop(r.Context(), r.PathValue("hub"), r.PathValue("svc"))
	respond(w, http.StatusOK, status, err)
}

func (s *Server) removeService(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("svc")
	err := s.supervisor.Remove(r.Context(), r.PathValue("hub"), name)
	respond(w, http.StatusOK, map[string]any{"removed": name}, err)
}

// serviceLogs writes the last ?tail lines as text. With ?follow=1 it keeps
// the response open and appends new output until the client disconnects.
func (s *Server) serviceLogs(w http.ResponseWriter, r *http.Request) {
	hubID, name := r.PathValue("hub"), r.PathValue("svc")
	if _, err := s.supervisor.Get(r.Context(), hubID, name); err != nil {
		writeError(w, err)
		return
	}
	tail := defaultLogTail
	if rawTail := r.URL.Query().Get("tail"); rawTail != "" {
		parsed, err := strconv.Atoi(rawTail)
		if err != nil {
			writeError(w, fmt.Errorf("%w: tail must be an integer", store.ErrInvalidInput))
			return
		}
		tail = parsed
	}
	path := s.supervisor.LogPath(hubID, name)
	text, offset, err := supervisor.TailLines(path, tail)
	if err != nil {
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	io.WriteString(w, text)
	if r.URL.Query().Get("follow") != "1" {
		return
	}
	flusher, canFlush := w.(http.Flusher)
	if !canFlush {
		return
	}
	flusher.Flush()
	ticker := time.NewTicker(logFollowPolling)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
		offset = copyNewLogBytes(w, path, offset)
		flusher.Flush()
	}
}

// copyNewLogBytes writes bytes past offset and returns the new offset. A file
// smaller than offset was rotated, so it restarts from the beginning.
func copyNewLogBytes(w io.Writer, path string, offset int64) int64 {
	file, err := os.Open(path)
	if err != nil {
		return offset
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() == offset {
		return offset
	}
	if info.Size() < offset {
		offset = 0
	}
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return offset
	}
	copied, _ := io.Copy(w, file)
	return offset + copied
}

func respond(w http.ResponseWriter, status int, body any, err error) {
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, status, body)
}
