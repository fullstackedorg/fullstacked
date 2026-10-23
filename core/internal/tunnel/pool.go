package tunnel

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Auto-scaling of a tunnel's sessions. A registered tunnel gets one
// WebSocket at once (so the first connection skips the handshake); every
// connection through it is a stream on its least loaded session. A session
// is clogged when it carries maxStreamsPerSession streams, when more than
// clogQueuedBytes wait to go out for over clogQueuedFor (a bulk transfer
// fills it), or when its round trip passes clogRTTFactor x its best plus
// clogRTTSlack (queueing on its TCP connection). With every session clogged
// the pool dials another, up to maxSessions; sessions idle for idleTimeout
// close, the last one after lastIdleTimeout.
var (
	maxSessions          = 8
	maxStreamsPerSession = 32
	clogQueuedBytes      = 512 * 1024
	clogQueuedFor        = 50 * time.Millisecond
	clogRTTFactor        = time.Duration(2)
	clogRTTSlack         = 20 * time.Millisecond
	idleTimeout          = 30 * time.Second
	lastIdleTimeout      = 2 * time.Minute
)

type pool struct {
	tunnel *Tunnel

	mu       sync.Mutex
	sessions []*session
	dialing  int
	waiters  []chan struct{} // opens waiting for a first session
	lastErr  error
	stopped  bool

	// idle timeouts, read once at creation (tests change the defaults)
	idleTimeout     time.Duration
	lastIdleTimeout time.Duration
}

func newPool(t *Tunnel) *pool {
	p := &pool{tunnel: t, idleTimeout: idleTimeout, lastIdleTimeout: lastIdleTimeout}
	go p.reapLoop()
	return p
}

// warm dials the first session ahead of the first connection
func (p *pool) warm() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.sessions) == 0 && p.dialing == 0 {
		p.dialLocked()
	}
}

func clogged(s *session) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || len(s.streams) >= maxStreamsPerSession {
		return true
	}
	if s.queuedBytes > clogQueuedBytes && time.Since(s.queuedSince) > clogQueuedFor {
		return true
	}
	return s.rttMin > 0 && s.rttSmooth > clogRTTFactor*s.rttMin+clogRTTSlack
}

func load(s *session) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.streams)*64*1024 + s.queuedBytes
}

// pick returns the least loaded session that is not clogged, else the least
// loaded one (and dials another while sessions remain), else nil (and dials).
func (p *pool) pickLocked() *session {
	var best, fallback *session
	for _, s := range p.sessions {
		if s.isClosed() {
			continue
		}
		if fallback == nil || load(s) < load(fallback) {
			fallback = s
		}
		if !clogged(s) && (best == nil || load(s) < load(best)) {
			best = s
		}
	}
	if best != nil {
		return best
	}
	if len(p.sessions)+p.dialing < maxSessions && p.dialing == 0 {
		p.dialLocked()
	}
	return fallback
}

// open starts a stream on a session, waiting for the first session if none
// is up yet
func (p *pool) open(ctx context.Context) (*muxStream, error) {
	for {
		p.mu.Lock()
		s := p.pickLocked()
		if s != nil {
			p.mu.Unlock()
			stream, err := s.openStream()
			if err == errSessionClosed {
				p.remove(s)
				continue
			}
			return stream, err
		}
		if p.dialing == 0 {
			p.dialLocked()
		}
		wait := make(chan struct{})
		p.waiters = append(p.waiters, wait)
		p.mu.Unlock()

		select {
		case <-wait:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		p.mu.Lock()
		err := p.lastErr
		up := len(p.sessions) > 0
		p.mu.Unlock()
		if !up && err != nil {
			return nil, err
		}
	}
}

func (p *pool) dialLocked() {
	p.dialing++
	go func() {
		s, err := p.dial()
		p.mu.Lock()
		p.dialing--
		p.lastErr = err
		if err == nil {
			if p.stopped {
				s.close(errSessionClosed)
			} else {
				p.sessions = append(p.sessions, s)
			}
		}
		waiters := p.waiters
		p.waiters = nil
		p.mu.Unlock()
		for _, w := range waiters {
			close(w)
		}
	}()
}

func (p *pool) dial() (*session, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	header := http.Header{}
	if p.tunnel.Authorization != "" {
		header.Set("Authorization", p.tunnel.Authorization)
	}
	conn, err := dialHub(ctx, p.tunnel.url(), &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return nil, err
	}
	// the hub sends one DATA frame per target read (32 KiB at most) and
	// control frames; no limit beyond the frame size is needed
	conn.SetReadLimit(-1)
	return newSession(conn), nil
}

func (p *pool) remove(s *session) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, x := range p.sessions {
		if x == s {
			p.sessions = append(p.sessions[:i], p.sessions[i+1:]...)
			return
		}
	}
}

// reapLoop drops closed sessions and closes idle ones
func (p *pool) reapLoop() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		p.mu.Lock()
		if p.stopped {
			p.mu.Unlock()
			return
		}
		alive := p.sessions[:0]
		for _, s := range p.sessions {
			if !s.isClosed() {
				alive = append(alive, s)
			}
		}
		kept := []*session{}
		for i, s := range alive {
			s.mu.Lock()
			idle := len(s.streams) == 0
			idleFor := time.Since(s.idleAt)
			s.mu.Unlock()
			// sessions still to look at, besides the ones kept so far
			others := len(kept) + len(alive) - i - 1
			if idle && ((others > 0 && idleFor > p.idleTimeout) || idleFor > p.lastIdleTimeout) {
				go s.close(errSessionClosed)
				continue
			}
			kept = append(kept, s)
		}
		p.sessions = kept
		p.mu.Unlock()
	}
}

// stop closes the pool's sessions once their streams end (re-registered tunnel)
func (p *pool) stop() {
	p.mu.Lock()
	p.stopped = true
	sessions := p.sessions
	p.sessions = nil
	p.mu.Unlock()
	for _, s := range sessions {
		go func(s *session) {
			for s.activeStreams() > 0 && !s.isClosed() {
				time.Sleep(time.Second)
			}
			s.close(errSessionClosed)
		}(s)
	}
}
