package server

import (
	"net/http"
	"strings"
	"sync"
	"time"
)

// DefaultAttachGrace keeps a hub attached between an agent's `wait` calls, so
// a click that lands while the agent is acting does not wake a daemon agent.
const DefaultAttachGrace = 2 * time.Minute

type attachments struct {
	mu    sync.Mutex
	grace time.Duration
	hubs  map[string]*attachment
}

type attachment struct {
	listeners  int
	releasedAt time.Time
}

func newAttachments(grace time.Duration) *attachments {
	return &attachments{grace: grace, hubs: map[string]*attachment{}}
}

func (a *attachments) acquire(hubID string) func() {
	a.mu.Lock()
	defer a.mu.Unlock()
	current, isKnown := a.hubs[hubID]
	if !isKnown {
		current = &attachment{}
		a.hubs[hubID] = current
	}
	current.listeners++
	var releaseOnce sync.Once
	return func() {
		releaseOnce.Do(func() {
			a.mu.Lock()
			defer a.mu.Unlock()
			current.listeners--
			current.releasedAt = time.Now()
		})
	}
}

func (a *attachments) attached(hubID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	current, isKnown := a.hubs[hubID]
	if !isKnown {
		return false
	}
	return current.listeners > 0 || time.Since(current.releasedAt) < a.grace
}

// SetAttachGrace sets how long a hub stays attached after its last agent
// listener disconnects.
func (s *Server) SetAttachGrace(grace time.Duration) { s.attachments.grace = grace }

// Attached reports whether a CLI agent is listening on the hub, or was within
// the grace period. Browser tabs and services never count.
func (s *Server) Attached(hubID string) bool { return s.attachments.attached(hubID) }

func (s *Server) attach(r *http.Request, hubID string) func() {
	isAgent := r.Header.Get(AgentHeader) == "1" && !strings.HasPrefix(r.Header.Get(SourceHeader), "svc:")
	if !isAgent {
		return func() {}
	}
	return s.attachments.acquire(hubID)
}
