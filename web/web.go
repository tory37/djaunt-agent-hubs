// Package web embeds the browser UI that the daemon serves at "/" and "/h/<hub>".
package web

import (
	"embed"
	"io/fs"
	"net/http"
	"strings"
)

//go:embed static
var embedded embed.FS

// Handler serves the static UI. The hub index and every /h/<hub> path get
// index.html; the single-page app routes from location.pathname.
func Handler() http.Handler {
	static, err := fs.Sub(embedded, "static")
	if err != nil {
		panic(err)
	}
	files := http.FileServerFS(static)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		if r.URL.Path == "/" || strings.HasPrefix(r.URL.Path, "/h/") {
			http.ServeFileFS(w, r, static, "index.html")
			return
		}
		files.ServeHTTP(w, r)
	})
}
