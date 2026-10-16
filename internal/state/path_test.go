package state

import (
	"encoding/json"
	"errors"
	"testing"
)

func decode(t *testing.T, raw string) map[string]any {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	return document
}

func encode(t *testing.T, document map[string]any) string {
	t.Helper()
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	return string(encoded)
}

func TestSetCreatesIntermediateObjects(t *testing.T) {
	document := map[string]any{}
	if err := Set(document, "ci.build.status", "green"); err != nil {
		t.Fatal(err)
	}
	if got, want := encode(t, document), `{"ci":{"build":{"status":"green"}}}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestSetAddressesArrayElementByID(t *testing.T) {
	document := decode(t, `{"items":[{"id":"tag","done":false},{"id":"deploy","done":false}]}`)
	if err := Set(document, "items.deploy.done", true); err != nil {
		t.Fatal(err)
	}
	want := `{"items":[{"done":false,"id":"tag"},{"done":true,"id":"deploy"}]}`
	if got := encode(t, document); got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestSetAddressesArrayElementByIndex(t *testing.T) {
	document := decode(t, `{"points":[1,2,3]}`)
	if err := Set(document, "points.1", 20.0); err != nil {
		t.Fatal(err)
	}
	if got, want := encode(t, document), `{"points":[1,20,3]}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestSetNilDeletesKey(t *testing.T) {
	document := decode(t, `{"a":{"b":1,"c":2}}`)
	if err := Set(document, "a.b", nil); err != nil {
		t.Fatal(err)
	}
	if got, want := encode(t, document), `{"a":{"c":2}}`; got != want {
		t.Fatalf("got %s want %s", got, want)
	}
}

func TestSetMissingArrayElementFails(t *testing.T) {
	document := decode(t, `{"items":[{"id":"tag"}]}`)
	err := Set(document, "items.nope.done", true)
	if !errors.Is(err, ErrPathNotFound) {
		t.Fatalf("want ErrPathNotFound, got %v", err)
	}
}

func TestSetThroughScalarFails(t *testing.T) {
	document := decode(t, `{"a":5}`)
	if err := Set(document, "a.b", 1.0); err == nil {
		t.Fatal("want error descending into a number")
	}
}

func TestGet(t *testing.T) {
	document := decode(t, `{"steps":[{"id":"deploy","status":"running"}]}`)
	value, err := Get(document, "steps.deploy.status")
	if err != nil {
		t.Fatal(err)
	}
	if value != "running" {
		t.Fatalf("got %v", value)
	}
	if _, err := Get(document, "steps.missing"); !errors.Is(err, ErrPathNotFound) {
		t.Fatalf("want ErrPathNotFound, got %v", err)
	}
}

func TestRejectsEmptySegments(t *testing.T) {
	for _, badPath := range []string{"", "a..b", ".a", "a."} {
		if err := Set(map[string]any{}, badPath, 1.0); err == nil {
			t.Errorf("path %q: want error", badPath)
		}
	}
}
