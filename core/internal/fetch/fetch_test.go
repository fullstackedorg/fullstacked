package fetch

import (
	"context"
	"errors"
	"fullstackedorg/fullstacked/internal/tunnel"
	"fullstackedorg/fullstacked/types"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestConcurrentResponseBodyCheck(t *testing.T) {
	var wg sync.WaitGroup

	// Concurrently invoke ResponseBody case, closeFetchResponse, and safelyGetResponse
	for i := 0; i < 100; i++ {
		wg.Add(3)

		go func(id int) {
			defer wg.Done()
			var res types.CoreCallResponse
			header := types.CoreCallHeader{
				Fn: ResponseBody,
			}
			data := []types.DeserializedData{
				{Data: float64(id)},
			}
			_ = Switch(nil, header, data, &res)
		}(i)

		go func(id int) {
			defer wg.Done()
			closeFetchResponse(id)
		}(i)

		go func(id int) {
			defer wg.Done()
			_ = safelyGetResponse(id)
		}(i)
	}

	wg.Wait()
}

// A target whose /drop closes the connection before any response, and a
// tunnel hub stand-in in front of it: one WebSocket per connection, piped to
// the target.
func startDropTarget(t *testing.T) (target *httptest.Server, drops *atomic.Int64) {
	drops = &atomic.Int64{}
	target = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/drop" {
			drops.Add(1)
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				conn.Close()
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
		w.Write([]byte("ok"))
	}))
	t.Cleanup(target.Close)
	return target, drops
}

func startHub(t *testing.T, targetAddr string) *httptest.Server {
	hub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		ws := websocket.NetConn(context.Background(), c, websocket.MessageBinary)
		tcp, err := net.Dial("tcp", targetAddr)
		if err != nil {
			ws.Close()
			return
		}
		go func() {
			io.Copy(tcp, ws)
			tcp.Close()
		}()
		io.Copy(ws, tcp)
		ws.Close()
	}))
	t.Cleanup(hub.Close)
	return hub
}

var nextTestFetchId = 1_000_000

// a request as the page makes it: the head, then the body read to its end
func testFetch(url string) (string, error) {
	fetchRequestsMutex.Lock()
	id := nextTestFetchId
	nextTestFetchId++
	fetchRequestsMutex.Unlock()
	defer closeFetchRequest(id)
	defer closeFetchResponse(id)

	_, err := FetchFnApply(id, RequestHead{Url: url, Method: "GET"}, nil)
	if err != nil {
		return "", err
	}
	body, err := io.ReadAll(safelyGetResponse(id).Body)
	return string(body), err
}

func checkDroppedRequest(t *testing.T, base string, drops *atomic.Int64) {
	// fills the pool: connections that served a request and went back
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if body, err := testFetch(base + "/ok"); err != nil || body != "ok" {
				t.Errorf("warm up: %q %v", body, err)
			}
		}()
	}
	wg.Wait()

	done := make(chan error, 1)
	go func() {
		_, err := testFetch(base + "/drop")
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, errDropped) {
			t.Fatalf("expected %v, got %v", errDropped, err)
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("a dropped request still retrying after 10s, %d attempts", drops.Load())
	}
	if n := drops.Load(); n > maxAttempts {
		t.Fatalf("a dropped request was sent %d times", n)
	}
}

// Go replays an idempotent request that a reused connection drops, and its
// pool counts a connection dialed for a request served by another one as
// reused: a request the server always drops was replayed, each time on a
// new connection, without end (a new tunnel connection each time)
func TestDroppedRequestRetriesAreBounded(t *testing.T) {
	target, drops := startDropTarget(t)
	checkDroppedRequest(t, target.URL, drops)
}

func TestDroppedRequestRetriesAreBoundedThroughTunnel(t *testing.T) {
	target, drops := startDropTarget(t)
	hub := startHub(t, target.Listener.Addr().String())
	hubURL, _ := url.Parse(hub.URL)
	port, _ := strconv.Atoi(hubURL.Port())
	if _, err := tunnel.RegisterTunnelFn(tunnel.Tunnel{
		Name:     "fetch-test-drop",
		Host:     hubURL.Hostname(),
		Port:     port,
		Unsecure: true,
	}); err != nil {
		t.Fatal(err)
	}
	checkDroppedRequest(t, "http://fetch-test-drop", drops)
}
