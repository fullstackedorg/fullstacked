package tunnel

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"
)

// a hub stub: the first `resets` connections read the upgrade request and
// are reset, the next ones get `status` (101 accepts the WebSocket)
func hubStub(t *testing.T, resets int32, status int) (string, *atomic.Int32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })

	var conns atomic.Int32
	accept := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if status != http.StatusSwitchingProtocols {
			w.WriteHeader(status)
			return
		}
		c, err := websocket.Accept(w, r, nil)
		if err == nil {
			c.CloseNow()
		}
	})

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			if conns.Add(1) <= resets {
				http.ReadRequest(bufio.NewReader(conn))
				conn.(*net.TCPConn).SetLinger(0)
				conn.Close()
				continue
			}
			go http.Serve(&oneConn{conn: conn}, accept)
		}
	}()

	return "ws://" + ln.Addr().String() + "/", &conns
}

// a listener of a single connection, for http.Serve
type oneConn struct {
	conn net.Conn
	done bool
}

func (l *oneConn) Accept() (net.Conn, error) {
	if l.done {
		select {}
	}
	l.done = true
	return l.conn, nil
}
func (l *oneConn) Close() error   { return nil }
func (l *oneConn) Addr() net.Addr { return l.conn.LocalAddr() }

func TestDialHubRetriesAReset(t *testing.T) {
	url, conns := hubStub(t, 1, http.StatusSwitchingProtocols)
	c, err := dialHub(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial after one reset: %v", err)
	}
	c.CloseNow()
	if n := conns.Load(); n != 2 {
		t.Fatalf("%d connections, want 2", n)
	}
}

func TestDialHubGivesUpAfterTheRetries(t *testing.T) {
	url, conns := hubStub(t, 100, http.StatusSwitchingProtocols)
	_, err := dialHub(context.Background(), url, nil)
	if err == nil || !transientDialError(err) {
		t.Fatalf("want the reset, got %v", err)
	}
	if n, want := conns.Load(), int32(len(dialRetryDelays)+1); n != want {
		t.Fatalf("%d connections, want %d", n, want)
	}
}

func TestDialHubRefusalFailsAtOnce(t *testing.T) {
	url, conns := hubStub(t, 0, http.StatusForbidden)
	if _, err := dialHub(context.Background(), url, nil); err == nil {
		t.Fatal("a refused dial succeeded")
	}
	if n := conns.Load(); n != 1 {
		t.Fatalf("%d connections, want 1", n)
	}
}
