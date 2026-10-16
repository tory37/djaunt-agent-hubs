package state

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

var ErrPathNotFound = errors.New("path not found")

const pathSeparator = "."

// Paths are dotted segments. Inside an array, a segment is either a numeric
// index or the "id" of an element, so agents can write "steps.deploy.status"
// without tracking positions.
func splitPath(path string) ([]string, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return nil, errors.New("empty path")
	}
	segments := strings.Split(trimmed, pathSeparator)
	for _, segment := range segments {
		if segment == "" {
			return nil, fmt.Errorf("path %q has an empty segment", path)
		}
	}
	return segments, nil
}

func Get(document map[string]any, path string) (any, error) {
	segments, err := splitPath(path)
	if err != nil {
		return nil, err
	}
	var current any = document
	for _, segment := range segments {
		child, found := lookupChild(current, segment)
		if !found {
			return nil, fmt.Errorf("%w: %s", ErrPathNotFound, path)
		}
		current = child
	}
	return current, nil
}

// Set writes value at path, creating intermediate objects as needed.
// A nil value deletes the key (or removes the array element).
func Set(document map[string]any, path string, value any) error {
	segments, err := splitPath(path)
	if err != nil {
		return err
	}
	parentSegments := segments[:len(segments)-1]
	finalSegment := segments[len(segments)-1]

	var parent any = document
	for _, segment := range parentSegments {
		parent, err = descendOrCreate(parent, segment, path)
		if err != nil {
			return err
		}
	}
	return assignChild(parent, finalSegment, value, path)
}

func lookupChild(container any, segment string) (any, bool) {
	switch typed := container.(type) {
	case map[string]any:
		child, found := typed[segment]
		return child, found
	case []any:
		index, found := arrayIndex(typed, segment)
		if !found {
			return nil, false
		}
		return typed[index], true
	default:
		return nil, false
	}
}

func descendOrCreate(container any, segment string, fullPath string) (any, error) {
	switch typed := container.(type) {
	case map[string]any:
		child, found := typed[segment]
		if !found || child == nil {
			created := map[string]any{}
			typed[segment] = created
			return created, nil
		}
		return child, nil
	case []any:
		index, found := arrayIndex(typed, segment)
		if !found {
			return nil, fmt.Errorf("%w: no element %q in %s", ErrPathNotFound, segment, fullPath)
		}
		return typed[index], nil
	default:
		return nil, fmt.Errorf("cannot descend into %q of %s: not an object or array", segment, fullPath)
	}
}

func assignChild(container any, segment string, value any, fullPath string) error {
	switch typed := container.(type) {
	case map[string]any:
		if value == nil {
			delete(typed, segment)
			return nil
		}
		typed[segment] = value
		return nil
	case []any:
		index, found := arrayIndex(typed, segment)
		if !found {
			return fmt.Errorf("%w: no element %q in %s", ErrPathNotFound, segment, fullPath)
		}
		if value == nil {
			return errors.New("removing array elements by patch is not supported; set the whole array")
		}
		typed[index] = value
		return nil
	default:
		return fmt.Errorf("cannot set %q of %s: not an object or array", segment, fullPath)
	}
}

func arrayIndex(elements []any, segment string) (int, bool) {
	if position, err := strconv.Atoi(segment); err == nil {
		isInRange := position >= 0 && position < len(elements)
		return position, isInRange
	}
	for position, element := range elements {
		object, isObject := element.(map[string]any)
		if !isObject {
			continue
		}
		if elementID, hasID := object["id"]; hasID && fmt.Sprint(elementID) == segment {
			return position, true
		}
	}
	return 0, false
}
