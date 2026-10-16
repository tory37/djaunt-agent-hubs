// Package match tests event payloads against key=value pairs. Keys are dotted
// state paths, so "values.env=prod" reads a nested field.
package match

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tory37/djaunt-agent-hubs/internal/state"
)

type Matcher struct {
	Key   string
	Value string
}

func Parse(rawMatchers []string) ([]Matcher, error) {
	matchers := make([]Matcher, 0, len(rawMatchers))
	for _, raw := range rawMatchers {
		key, value, hasEquals := strings.Cut(raw, "=")
		if !hasEquals || key == "" {
			return nil, fmt.Errorf("match %q must be key=value", raw)
		}
		matchers = append(matchers, Matcher{Key: key, Value: value})
	}
	return matchers, nil
}

// Payload reports whether every matcher's key holds its value. No matchers
// match any payload.
func Payload(payload json.RawMessage, matchers []Matcher) bool {
	if len(matchers) == 0 {
		return true
	}
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		return false
	}
	for _, matcher := range matchers {
		value, err := state.Get(document, matcher.Key)
		if err != nil || fmt.Sprint(value) != matcher.Value {
			return false
		}
	}
	return true
}
