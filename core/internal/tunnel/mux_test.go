package tunnel

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/binary"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// muxHub is a hub stub speaking the mux protocol: every OPEN dials target
// (or answers RESET refuse when set), DATA goes to the target socket with
// its credit given back, the target's bytes come back as DATA, FIN and
// RESET close like the hub's splicing.
type muxHub struct {
	server   *httptest.Server
	target   string
	refuse   string
	sessions atomic.Int32
	streams  atomic.Int32
}

func newMuxHub(t *testing.T, target string) *muxHub {
	h := &muxHub{target: target}
	h.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c.SetReadLimit(-1)
		h.sessions.Add(1)
		h.serve(c)
	}))
	t.Cleanup(h.server.Close)
	return h
}

func (h *muxHub) serve(c *websocket.Conn) {
	var writeMu sync.Mutex
	send := func(frame []byte) {
		writeMu.Lock()
		defer writeMu.Unlock()
		c.Write(context.Background(), websocket.MessageBinary, frame)
	}
	targets := map[uint32]net.Conn{}
	var mu sync.Mutex
	for {
		_, message, err := c.Read(context.Background())
		if err != nil {
			mu.Lock()
			for _, t := range targets {
				t.Close()
			}
			mu.Unlock()
			return
		}
		typ, id, payload, err := decodeFrame(message)
		if err != nil {
			continue
		}
		switch typ {
		case frameOpen:
			h.streams.Add(1)
			if h.refuse != "" {
				send(encodeFrame(frameReset, id, []byte(h.refuse)))
				continue
			}
			target, err := net.Dial("tcp", h.target)
			if err != nil {
				send(encodeFrame(frameReset, id, []byte("target_unreachable")))
				continue
			}
			mu.Lock()
			targets[id] = target
			mu.Unlock()
			send(encodeFrame(frameOpened, id, nil))
			go func(id uint32, target net.Conn) {
				buf := make([]byte, maxDataPayload)
				for {
					n, err := target.Read(buf)
					if n > 0 {
						send(encodeFrame(frameData, id, buf[:n]))
					}
					if err != nil {
						send(encodeFrame(frameFin, id, nil))
						return
					}
				}
			}(id, target)
		case frameData:
			mu.Lock()
			target := targets[id]
			mu.Unlock()
			if target != nil {
				target.Write(payload)
				send(encodeWindow(id, uint32(len(payload))))
			}
		case frameFin:
			mu.Lock()
			target := targets[id]
			mu.Unlock()
			if tcp, ok := target.(*net.TCPConn); ok {
				tcp.CloseWrite()
			}
		case frameReset:
			mu.Lock()
			if target := targets[id]; target != nil {
				target.Close()
				delete(targets, id)
			}
			mu.Unlock()
		case frameWindow:
			_ = binary.BigEndian.Uint32(payload)
		}
	}
}

// echoServer echoes every connection until its client half-closes
func echoServer(t *testing.T) string {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				io.Copy(conn, conn)
				conn.(*net.TCPConn).CloseWrite()
			}()
		}
	}()
	return ln.Addr().String()
}

func registerStub(t *testing.T, h *muxHub) *Tunnel {
	host := strings.TrimPrefix(h.server.URL, "http://")
	hostname, port, _ := net.SplitHostPort(host)
	name, err := RegisterTunnelFn(Tunnel{Name: t.Name(), Host: hostname, Port: atoi(port), Unsecure: true})
	if err != nil {
		t.Fatal(err)
	}
	return FindTunnel(name)
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	return n
}

func roundTrip(t *testing.T, tun *Tunnel, payload []byte) {
	t.Helper()
	conn, err := tun.Dial(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	go func() {
		conn.Write(payload)
		conn.(*muxStream).CloseWrite()
	}()
	got, err := io.ReadAll(conn)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("echo: got %d bytes, want %d", len(got), len(payload))
	}
}

func TestMuxStreamsShareOneSession(t *testing.T) {
	h := newMuxHub(t, echoServer(t))
	tun := registerStub(t, h)
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			roundTrip(t, tun, []byte("hello through one session"))
		}()
	}
	wg.Wait()
	if n := h.sessions.Load(); n != 1 {
		t.Fatalf("%d sessions for 20 streams, want 1", n)
	}
	if n := h.streams.Load(); n != 20 {
		t.Fatalf("%d streams, want 20", n)
	}
}

func TestMuxScalesPastTheStreamCap(t *testing.T) {
	h := newMuxHub(t, echoServer(t))
	tun := registerStub(t, h)
	var conns []net.Conn
	for i := 0; i < maxStreamsPerSession+8; i++ {
		conn, err := tun.Dial(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, conn)
	}
	for _, c := range conns {
		c.Close()
	}
	if n := h.sessions.Load(); n != 2 {
		t.Fatalf("%d sessions for %d open streams, want 2", n, maxStreamsPerSession+8)
	}
}

func TestMuxLargeTransfersBothWays(t *testing.T) {
	h := newMuxHub(t, echoServer(t))
	tun := registerStub(t, h)
	payload := make([]byte, 5<<20)
	rand.Read(payload)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			roundTrip(t, tun, payload)
		}()
	}
	wg.Wait()
}

func TestMuxRefusedOpenIsADialError(t *testing.T) {
	h := newMuxHub(t, echoServer(t))
	h.refuse = "target_unreachable"
	tun := registerStub(t, h)
	_, err := tun.Dial(context.Background())
	if err == nil || !strings.Contains(err.Error(), "target_unreachable") {
		t.Fatalf("want the hub's reason, got %v", err)
	}
}

func TestMuxIdleSessionsClose(t *testing.T) {
	idle, last := idleTimeout, lastIdleTimeout
	idleTimeout, lastIdleTimeout = 100*time.Millisecond, 100*time.Millisecond
	defer func() { idleTimeout, lastIdleTimeout = idle, last }()

	h := newMuxHub(t, echoServer(t))
	tun := registerStub(t, h)
	roundTrip(t, tun, []byte("x"))
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		tun.pool.mu.Lock()
		n := len(tun.pool.sessions)
		tun.pool.mu.Unlock()
		if n == 0 {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("idle session still open")
}

func TestMuxClogScaleOut(t *testing.T) {
	s := &session{streams: map[uint32]*muxStream{}}
	s.queueCond = sync.NewCond(&s.mu)
	if clogged(s) {
		t.Fatal("an empty session is not clogged")
	}
	s.queuedBytes = clogQueuedBytes + 1
	s.queuedSince = time.Now().Add(-time.Second)
	if !clogged(s) {
		t.Fatal("a session with a backed-up queue is clogged")
	}
	s.queuedBytes = 0
	s.rttMin, s.rttSmooth = 10*time.Millisecond, 80*time.Millisecond
	if !clogged(s) {
		t.Fatal("a session whose round trip grew is clogged")
	}
}
