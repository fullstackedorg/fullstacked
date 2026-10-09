package router

import (
	"bytes"
	"fullstackedorg/fullstacked/types"
	"os"
	"path/filepath"
	"testing"

	"fullstackedorg/fullstacked/internal/store"
)

func TestHandleRequest(t *testing.T) {
	root := t.TempDir()
	build := filepath.Join(root, "out")
	os.MkdirAll(build, 0o755)
	os.WriteFile(filepath.Join(build, "index.html"), []byte("<html>"), 0o644)
	os.WriteFile(filepath.Join(root, "style.css"), []byte("body{}"), 0o644)

	ctxId := store.NewContext(root, build, true)
	defer store.EndContext(ctxId)

	check := func(path string, body []byte, status int, mimeType string, data []byte) {
		t.Helper()
		s, m, d := HandleRequest(ctxId, path, body)
		if s != status || m != mimeType || (data != nil && !bytes.Equal(d, data)) {
			t.Fatalf("%s: %d %s %q", path, s, m, d)
		}
	}

	Platform = "test"
	check("/platform", nil, 200, "text/plain", []byte("test"))
	check("/bridge", nil, 200, "text/plain", []byte("binary"))
	BinaryCalls = false
	check("/bridge", nil, 200, "text/plain", []byte("message"))
	BinaryCalls = true

	// the build directory first, then the root, directories serve index.html
	check("/", nil, 200, "text/html; charset=utf-8", []byte("<html>"))
	check("/style.css", nil, 200, "text/css; charset=utf-8", []byte("body{}"))
	check("/missing.js", nil, 404, "text/plain", []byte("Not Found"))

	s, m, d := HandleRequest(ctxId, "/call", echoPayload(t, ctxId, 3, []byte("hi")))
	if s != 200 || m != "application/octet-stream" || d[0] != types.CoreResponseData {
		t.Fatalf("/call: %d %s %v", s, m, d)
	}
	s, _, d = HandleRequest(ctxId, "/sync", []byte{ctxId})
	if s != 200 || d[0] != types.CoreResponseError {
		t.Fatalf("/sync with a bad payload: %d %v", s, d)
	}

	ctx, _ := store.GetContext(ctxId)
	ctx.Frames.Attach()
	check("/stream/detach", nil, 200, "text/plain", nil)
	if ctx.Frames.Attached() {
		t.Fatal("/stream/detach left the reader attached")
	}
}
