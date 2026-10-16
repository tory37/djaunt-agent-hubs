package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandlerRoutes(t *testing.T) {
	cases := []struct {
		path        string
		wantStatus  int
		wantContent string
	}{
		{"/", http.StatusOK, `<div id="app">`},
		{"/h/release-42", http.StatusOK, `<div id="app">`},
		{"/app.js", http.StatusOK, "import"},
		{"/vendor/uPlot.iife.min.js", http.StatusOK, "uPlot"},
		{"/nope.js", http.StatusNotFound, ""},
	}
	handler := Handler()
	for _, testCase := range cases {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, testCase.path, nil))
		if recorder.Code != testCase.wantStatus {
			t.Errorf("%s: want %d, got %d", testCase.path, testCase.wantStatus, recorder.Code)
		}
		if !strings.Contains(recorder.Body.String(), testCase.wantContent) {
			t.Errorf("%s: body missing %q", testCase.path, testCase.wantContent)
		}
	}
}
