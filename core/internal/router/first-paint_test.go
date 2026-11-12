package router

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"fullstackedorg/fullstacked/internal/store"
)

func TestFirstPaintInsertAt(t *testing.T) {
	cases := []struct {
		page string
		at   string // the page from the insertion point
		ok   bool
	}{
		{`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>`, `<meta charset="utf-8">`, true},
		{`<!doctype html><html><body><script type="module" src="index.js"></script></body></html>`, `<body>`, true},
		{`<!doctype html><p>hi</p>`, `<p>hi</p>`, true},
		{`<p>hi</p>`, `<p>hi</p>`, true},
		{`<html><head><script src="a.js" defer></script><script async src="b.js"></script><script>inline()</script><script type="application/json" src="data.json"></script></head></html>`, `<script src="a.js" defer>`, true},
		// a classic script blocks parsing: the page could never paint first
		{`<html><head><script src="legacy.js"></script></head></html>`, "", false},
		{`<html><head><SCRIPT SRC="legacy.js" TYPE="text/javascript"></SCRIPT></head></html>`, "", false},
		// a Content Security Policy may refuse the inline script
		{`<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'self'"></head></html>`, "", false},
	}
	for _, c := range cases {
		at, ok := firstPaintInsertAt([]byte(c.page))
		if ok != c.ok || (ok && !strings.HasPrefix(c.page[at:], c.at)) {
			t.Errorf("%s: at %d (%q), ok %v", c.page, at, c.page[at:], ok)
		}
	}
}

func firstPaintContext(t *testing.T, page string) uint8 {
	t.Helper()
	root := t.TempDir()
	build := filepath.Join(root, "out")
	os.MkdirAll(build, 0o755)
	os.WriteFile(filepath.Join(build, "index.html"), []byte(page), 0o644)
	os.WriteFile(filepath.Join(build, "index.js"), []byte("run()"), 0o644)
	os.WriteFile(filepath.Join(build, "index.css"), []byte("html{background:#000}"), 0o644)
	ctxId := store.NewContext(root, build, true)
	t.Cleanup(func() { store.EndContext(ctxId) })
	return ctxId
}

// a request answered on its own goroutine, like a host's worker thread
func requestAsync(ctxId uint8, path string) <-chan []byte {
	done := make(chan []byte, 1)
	go func() {
		_, _, data := HandleRequest(ctxId, path, nil)
		done <- data
	}()
	return done
}

func TestFirstPaintHoldsScripts(t *testing.T) {
	Platform = "apple"
	defer func() { Platform = "" }()
	page := `<!doctype html><html><head><link rel="stylesheet" href="index.css"></head><body><script type="module" src="index.js"></script></body></html>`
	ctxId := firstPaintContext(t, page)

	_, mimeType, served := HandleRequest(ctxId, "/", nil)
	if !strings.HasPrefix(mimeType, "text/html") || !bytes.Contains(served, []byte(firstPaintScript)) {
		t.Fatalf("the page has no first-paint script: %s", served)
	}
	if want := strings.Replace(page, "<head>", "<head>"+firstPaintScript, 1); string(served) != want {
		t.Fatalf("the script is not at the top of <head>: %s", served)
	}
	// the stylesheet goes, the script waits for the first paint
	if _, _, css := HandleRequest(ctxId, "/index.css", nil); string(css) != "html{background:#000}" {
		t.Fatalf("the stylesheet was not served: %q", css)
	}
	script := requestAsync(ctxId, "/index.js")
	select {
	case <-script:
		t.Fatal("the script was served before the first paint")
	case <-time.After(100 * time.Millisecond):
	}
	if status, _, _ := HandleRequest(ctxId, FirstPaintPath, nil); status != 200 {
		t.Fatalf("%s: %d", FirstPaintPath, status)
	}
	select {
	case js := <-script:
		if string(js) != "run()" {
			t.Fatalf("the script: %q", js)
		}
	case <-time.After(time.Second):
		t.Fatal("the script was still held after the first paint")
	}

	// the page again (a reload): as built, its scripts go at once
	if _, _, again := HandleRequest(ctxId, "/", nil); string(again) != page {
		t.Fatalf("the second page was changed: %s", again)
	}
	if _, _, js := HandleRequest(ctxId, "/index.js", nil); string(js) != "run()" {
		t.Fatalf("the script after: %q", js)
	}
}

func TestFirstPaintTimeout(t *testing.T) {
	Platform = "android"
	defer func() { Platform = "" }()
	timeout := FirstPaintTimeout
	FirstPaintTimeout = 150 * time.Millisecond
	defer func() { FirstPaintTimeout = timeout }()
	ctxId := firstPaintContext(t, `<html><head></head><body><script type="module" src="index.js"></script></body></html>`)

	HandleRequest(ctxId, "/", nil)
	start := time.Now()
	select {
	case <-requestAsync(ctxId, "/index.js"):
		if waited := time.Since(start); waited < 100*time.Millisecond {
			t.Fatalf("the script did not wait: %s", waited)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the script was held past the timeout")
	}
}

func TestFirstPaintOff(t *testing.T) {
	page := `<html><head></head><body><script type="module" src="index.js"></script></body></html>`

	// node answers on its event loop: no first paint
	Platform = "node"
	ctxId := firstPaintContext(t, page)
	if _, _, served := HandleRequest(ctxId, "/", nil); string(served) != page {
		t.Fatalf("node: the page was changed: %s", served)
	}
	if _, _, js := HandleRequest(ctxId, "/index.js", nil); string(js) != "run()" {
		t.Fatalf("node: the script: %q", js)
	}

	// a classic script blocks parsing: the page runs as built
	Platform = "windows"
	defer func() { Platform = "" }()
	legacy := `<html><head><script src="index.js"></script></head></html>`
	ctxId = firstPaintContext(t, legacy)
	if _, _, served := HandleRequest(ctxId, "/", nil); string(served) != legacy {
		t.Fatalf("legacy: the page was changed: %s", served)
	}
	select {
	case <-requestAsync(ctxId, "/index.js"):
	case <-time.After(time.Second):
		t.Fatal("legacy: the script was held")
	}
}
