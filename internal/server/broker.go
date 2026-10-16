package server

import (
	"encoding/json"
	"sync"
)

const (
	MessageEvent  = "event"
	MessageBlocks = "blocks"
	MessageState  = "state"
	MessageHub    = "hub"
)

type Message struct {
	Kind string          `json:"kind"`
	Seq  int64           `json:"seq,omitempty"`
	Data json.RawMessage `json:"data"`
}

const subscriberBufferSize = 64

// Broker fans out hub changes to live subscribers. A subscriber that falls
// behind is dropped rather than blocking writers; it reconnects and catches
// up from the event log using its last seq.
type Broker struct {
	mutex       sync.Mutex
	subscribers map[string]map[chan Message]struct{}
}

func NewBroker() *Broker {
	return &Broker{subscribers: map[string]map[chan Message]struct{}{}}
}

func (b *Broker) Subscribe(hubID string) (<-chan Message, func()) {
	channel := make(chan Message, subscriberBufferSize)
	b.mutex.Lock()
	if b.subscribers[hubID] == nil {
		b.subscribers[hubID] = map[chan Message]struct{}{}
	}
	b.subscribers[hubID][channel] = struct{}{}
	b.mutex.Unlock()

	unsubscribe := func() {
		b.mutex.Lock()
		defer b.mutex.Unlock()
		b.removeLocked(hubID, channel)
	}
	return channel, unsubscribe
}

func (b *Broker) Publish(hubID string, message Message) {
	b.mutex.Lock()
	defer b.mutex.Unlock()
	for channel := range b.subscribers[hubID] {
		select {
		case channel <- message:
		default:
			b.removeLocked(hubID, channel)
		}
	}
}

func (b *Broker) removeLocked(hubID string, channel chan Message) {
	hubSubscribers := b.subscribers[hubID]
	if _, isSubscribed := hubSubscribers[channel]; !isSubscribed {
		return
	}
	delete(hubSubscribers, channel)
	close(channel)
	if len(hubSubscribers) == 0 {
		delete(b.subscribers, hubID)
	}
}
