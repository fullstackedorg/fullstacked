package router

import (
	"bytes"
	"fullstackedorg/fullstacked/types"
	"strings"
	"time"

	"golang.org/x/net/html"
)

// The first paint: a page of the app shows its HTML and CSS before its
// JavaScript runs, so an animation that starts with the page's JavaScript
// starts on a page that is on the screen.
//
// The first time a context answers its page, the core adds a small script
// at the top of the HTML it answers (the file on disk is unchanged, a build's
// out/ runs anywhere as built). Once the page is parsed and has painted a
// frame, the script requests FirstPaintPath. Until then, or FirstPaintTimeout
// at most, the context's scripts are held: their requests are answered only
// then. Later pages of the context run as before.
//
// A page that could not paint first runs as before: a classic script that
// blocks parsing (it would never let the page paint) or a Content Security
// Policy (it may refuse the inline script).

const FirstPaintPath = "/first-paint"

// the longest a page's scripts wait for its first paint
var FirstPaintTimeout = 1500 * time.Millisecond

// The hosts that hold scripts. A held script holds the thread answering it:
// these hosts answer the page's files on worker threads. Node's server answers
// on its event loop (the first-paint request would wait behind the held
// script), its pages run as before.
var firstPaintHosts = map[string]bool{
	"apple":   true,
	"android": true,
	"windows": true,
	"linux":   true,
}

// parsed, then two frames: the first one painted
const firstPaintScript = `<script>(function(){var d=document;function p(){requestAnimationFrame(function(){requestAnimationFrame(function(){fetch("` + FirstPaintPath + `").catch(function(){})})})}if(d.readyState!=="loading")p();else d.addEventListener("readystatechange",function f(){d.removeEventListener("readystatechange",f);p()})})()</script>`

// The page's HTML with the first-paint script, the first time the context
// answers one, and the context's scripts held until the page painted.
func firstPaintPage(ctx *types.Context, page []byte) []byte {
	gate := ctx.FirstPaint
	if gate == nil || !firstPaintHosts[Platform] {
		return page
	}

	gate.Mutex.Lock()
	defer gate.Mutex.Unlock()
	if gate.Served {
		return page
	}
	gate.Served = true

	at, ok := firstPaintInsertAt(page)
	if !ok {
		return page
	}

	gate.Open = make(chan struct{})
	time.AfterFunc(FirstPaintTimeout, func() { firstPainted(ctx) })

	out := make([]byte, 0, len(page)+len(firstPaintScript))
	out = append(out, page[:at]...)
	out = append(out, firstPaintScript...)
	return append(out, page[at:]...)
}

// the page painted (or the wait is over): its scripts go
func firstPainted(ctx *types.Context) {
	gate := ctx.FirstPaint
	if gate == nil {
		return
	}
	gate.Mutex.Lock()
	defer gate.Mutex.Unlock()
	if gate.Open != nil && !gate.Released {
		gate.Released = true
		close(gate.Open)
	}
}

// a script of the page waits for the page's first paint
func waitFirstPaint(ctx *types.Context) {
	gate := ctx.FirstPaint
	if gate == nil {
		return
	}
	gate.Mutex.Lock()
	open, released := gate.Open, gate.Released
	gate.Mutex.Unlock()
	if open != nil && !released {
		<-open
	}
}

func isScript(mimeType string) bool {
	return strings.Contains(mimeType, "javascript")
}

// Where the script goes: at the top of <head>, else of <html>, else after
// the doctype (before it, the page would render in quirks mode). False when
// the page can't wait for its first paint.
func firstPaintInsertAt(page []byte) (int, bool) {
	z := html.NewTokenizer(bytes.NewReader(page))
	offset := 0
	head, root, doctype := -1, -1, -1
	for {
		tt := z.Next()
		if tt == html.ErrorToken {
			break
		}
		end := offset + len(z.Raw())

		switch tt {
		case html.DoctypeToken:
			if doctype < 0 {
				doctype = end
			}
		case html.StartTagToken, html.SelfClosingTagToken:
			name, more := z.TagName()
			attrs := map[string]string{}
			for more {
				var key, value []byte
				key, value, more = z.TagAttr()
				attrs[string(key)] = string(value)
			}
			switch string(name) {
			case "head":
				if head < 0 {
					head = end
				}
			case "html":
				if root < 0 {
					root = end
				}
			case "script":
				if blocksParsing(attrs) {
					return 0, false
				}
			case "meta":
				if strings.EqualFold(attrs["http-equiv"], "content-security-policy") {
					return 0, false
				}
			}
		}
		offset = end
	}

	for _, at := range []int{head, root, doctype} {
		if at >= 0 {
			return at, true
		}
	}
	return 0, true
}

// a classic script loaded from a file, run as the parser meets it
func blocksParsing(attrs map[string]string) bool {
	if _, src := attrs["src"]; !src {
		return false
	}
	if _, async := attrs["async"]; async {
		return false
	}
	if _, deferred := attrs["defer"]; deferred {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(attrs["type"])) {
	case "", "text/javascript", "application/javascript":
		return true
	}
	// a module (deferred) or not a script at all
	return false
}
