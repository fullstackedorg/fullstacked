package tunnel

import (
	"errors"
	"io"
	"net"
	"os"
	"sync"
	"time"
)

// muxStream is one stream of a session, as a net.Conn: Write sends DATA
// within the hub's credit, Read returns what the hub sent and gives the
// credit back once read. CloseWrite sends FIN, Close sends RESET unless both
// sides finished. A RESET before OPENED is the dial failing (Opened returns
// it).
type muxStream struct {
	session *session
	id      uint32

	mu       sync.Mutex
	cond     *sync.Cond
	opened   bool
	openWait chan struct{}
	buf      []byte
	received uint64 // bytes received
	consumed uint64 // bytes read by the application
	granted  uint64 // credit given to the hub, received bytes included
	credit   int    // bytes this side may still send
	finIn    bool   // the hub sent FIN
	finOut   bool   // this side sent FIN
	reset    string // RESET reason (received, or session_closed)
	closed   bool   // closed locally

	readDeadline  time.Time
	writeDeadline time.Time
}

type resetError struct{ reason string }

func (e *resetError) Error() string { return e.reason }

func newMuxStream(s *session, id uint32) *muxStream {
	stream := &muxStream{
		session:  s,
		id:       id,
		openWait: make(chan struct{}),
		granted:  streamWindow,
		credit:   streamWindow,
	}
	stream.cond = sync.NewCond(&stream.mu)
	return stream
}

// Opened waits for OPENED and returns nil, or the RESET reason (the dial
// failed), or the context's error.
func (m *muxStream) Opened(done <-chan struct{}) error {
	select {
	case <-m.openWait:
	case <-done:
		return errors.New("tunnel: open canceled")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.opened {
		return &resetError{m.reset}
	}
	return nil
}

func (m *muxStream) handleOpened() {
	m.mu.Lock()
	if !m.opened && m.reset == "" {
		m.opened = true
		close(m.openWait)
	}
	m.mu.Unlock()
}

func (m *muxStream) handleData(payload []byte) {
	m.mu.Lock()
	m.buf = append(m.buf, payload...)
	m.received += uint64(len(payload))
	m.cond.Broadcast()
	m.mu.Unlock()
}

func (m *muxStream) handleWindow(increment uint32) {
	m.mu.Lock()
	m.credit += int(increment)
	m.cond.Broadcast()
	m.mu.Unlock()
}

func (m *muxStream) handleFin() {
	m.mu.Lock()
	m.finIn = true
	done := m.finOut
	m.cond.Broadcast()
	m.mu.Unlock()
	if done {
		m.session.release(m.id)
	}
}

func (m *muxStream) handleReset(reason string) {
	m.mu.Lock()
	if m.reset == "" {
		if reason == "" {
			reason = "stream_error"
		}
		m.reset = reason
	}
	if !m.opened {
		select {
		case <-m.openWait:
		default:
			close(m.openWait)
		}
	}
	m.cond.Broadcast()
	m.mu.Unlock()
	m.session.release(m.id)
}

func (m *muxStream) Read(p []byte) (int, error) {
	m.mu.Lock()
	for len(m.buf) == 0 && !m.finIn && m.reset == "" && !m.closed {
		if !m.readDeadline.IsZero() && !time.Now().Before(m.readDeadline) {
			m.mu.Unlock()
			return 0, os.ErrDeadlineExceeded
		}
		m.waitWithDeadline(m.readDeadline)
	}
	if len(m.buf) == 0 {
		defer m.mu.Unlock()
		if m.closed {
			return 0, net.ErrClosed
		}
		if m.finIn {
			return 0, io.EOF
		}
		return 0, &resetError{m.reset}
	}
	n := copy(p, m.buf)
	m.buf = m.buf[n:]
	m.consumed += uint64(n)
	// keep the hub's window at streamWindow beyond what was read
	var increment uint64
	if target := m.consumed + streamWindow; target-m.granted >= streamWindow/2 && !m.finIn && m.reset == "" {
		increment = target - m.granted
		m.granted = target
	}
	m.mu.Unlock()
	if increment > 0 {
		m.session.enqueue(encodeWindow(m.id, uint32(increment)), false)
	}
	return n, nil
}

func (m *muxStream) Write(p []byte) (int, error) {
	written := 0
	for written < len(p) {
		m.mu.Lock()
		for m.credit <= 0 && m.reset == "" && !m.closed && !m.finOut {
			if !m.writeDeadline.IsZero() && !time.Now().Before(m.writeDeadline) {
				m.mu.Unlock()
				return written, os.ErrDeadlineExceeded
			}
			m.waitWithDeadline(m.writeDeadline)
		}
		if m.closed || m.finOut {
			m.mu.Unlock()
			return written, net.ErrClosed
		}
		if m.reset != "" {
			reason := m.reset
			m.mu.Unlock()
			return written, &resetError{reason}
		}
		size := min(maxDataPayload, m.credit, len(p)-written)
		m.credit -= size
		m.mu.Unlock()
		if !m.session.enqueue(encodeFrame(frameData, m.id, p[written:written+size]), true) {
			return written, errSessionClosed
		}
		written += size
	}
	return written, nil
}

// CloseWrite sends FIN: no more bytes from this side.
func (m *muxStream) CloseWrite() error {
	m.mu.Lock()
	if m.finOut || m.closed || m.reset != "" {
		m.mu.Unlock()
		return nil
	}
	m.finOut = true
	done := m.finIn
	m.cond.Broadcast()
	m.mu.Unlock()
	m.session.enqueue(encodeFrame(frameFin, m.id, nil), false)
	if done {
		m.session.release(m.id)
	}
	return nil
}

// Close ends the stream: RESET (client_close) unless both sides sent FIN.
func (m *muxStream) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	graceful := (m.finIn && m.finOut) || m.reset != ""
	m.cond.Broadcast()
	m.mu.Unlock()
	if !graceful {
		m.session.enqueue(encodeFrame(frameReset, m.id, []byte("client_close")), false)
	}
	m.session.release(m.id)
	return nil
}

// waitWithDeadline waits on cond (mu held), woken at the deadline if any
func (m *muxStream) waitWithDeadline(deadline time.Time) {
	if deadline.IsZero() {
		m.cond.Wait()
		return
	}
	timer := time.AfterFunc(time.Until(deadline), func() {
		m.mu.Lock()
		m.cond.Broadcast()
		m.mu.Unlock()
	})
	m.cond.Wait()
	timer.Stop()
}

func (m *muxStream) LocalAddr() net.Addr  { return muxAddr{} }
func (m *muxStream) RemoteAddr() net.Addr { return muxAddr{} }

func (m *muxStream) SetDeadline(t time.Time) error {
	m.mu.Lock()
	m.readDeadline, m.writeDeadline = t, t
	m.cond.Broadcast()
	m.mu.Unlock()
	return nil
}

func (m *muxStream) SetReadDeadline(t time.Time) error {
	m.mu.Lock()
	m.readDeadline = t
	m.cond.Broadcast()
	m.mu.Unlock()
	return nil
}

func (m *muxStream) SetWriteDeadline(t time.Time) error {
	m.mu.Lock()
	m.writeDeadline = t
	m.cond.Broadcast()
	m.mu.Unlock()
	return nil
}

type muxAddr struct{}

func (muxAddr) Network() string { return "fullstacked-tunnel" }
func (muxAddr) String() string  { return "fullstacked-tunnel" }
