package server

import (
	"errors"
	"fmt"

	"github.com/tory37/djaunt-agent-hubs/internal/state"
	"github.com/tory37/djaunt-agent-hubs/internal/store"
)

func stateValue(document map[string]any, path string) (any, error) {
	value, err := state.Get(document, path)
	if errors.Is(err, state.ErrPathNotFound) {
		return nil, fmt.Errorf("%w: %v", store.ErrNotFound, err)
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %v", store.ErrInvalidInput, err)
	}
	return value, nil
}
