package tunnel

import (
	"context"
	"encoding/binary"
	"errors"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// session is one WebSocket to the hub carrying many streams. A writer
// goroutine sends the queued frames in order, so the pool can see how much
// waits (queuedBytes); a reader goroutine dispatches the hub's frames; while
// streams are open a ping measures the round trip.
type session struct {
	conn *websocket.Conn

	mu      sync.Mutex
	streams map[uint32]*muxStream
	nextID  uint32
	closed  bool
	err     error
	idleAt  time.Time // when the last stream ended

	// writer queue
	queue       [][]byte
	queuedBytes int
	queuedSince time.Time // when the queue last became non empty
	queueCond   *sync.Cond

	// round trip of the WebSocket (ping), the session's best and smoothed
	rttMin    time.Duration
	rttSmooth time.Duration

	done chan struct{}
}

var errSessionClosed = errors.New("tunnel session closed")

// queue size beyond which writers wait for the writer goroutine
const maxQueuedBytes = 4 * 1024 * 1024

func newSession(conn *websocket.Conn) *session {
	s := &session{
		conn:    conn,
		streams: map[uint32]*muxStream{},
		nextID:  1,
		idleAt:  time.Now(),
		done:    make(chan struct{}),
	}
	s.queueCond = sync.NewCond(&s.mu)
	go s.writeLoop()
	go s.readLoop()
	go s.pingLoop()
	return s
}

// enqueue queues a frame; waits while the queue is over maxQueuedBytes.
// False once the session is closed.
func (s *session) enqueue(frame []byte, wait bool) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for wait && !s.closed && s.queuedBytes > maxQueuedBytes {
		s.queueCond.Wait()
	}
	if s.closed {
		return false
	}
	if len(s.queue) == 0 {
		s.queuedSince = time.Now()
	}
	s.queue = append(s.queue, frame)
	s.queuedBytes += len(frame)
	s.queueCond.Broadcast()
	return true
}

func (s *session) writeLoop() {
	for {
		s.mu.Lock()
		for len(s.queue) == 0 && !s.closed {
			s.queueCond.Wait()
		}
		if s.closed {
			s.mu.Unlock()
			return
		}
		frames := s.queue
		s.queue = nil
		s.mu.Unlock()

		for i, frame := range frames {
			if err := s.conn.Write(context.Background(), websocket.MessageBinary, frame); err != nil {
				s.close(err)
				return
			}
			s.mu.Lock()
			s.queuedBytes -= len(frame)
			if i == len(frames)-1 && len(s.queue) > 0 {
				s.queuedSince = time.Now()
			}
			s.queueCond.Broadcast()
			s.mu.Unlock()
		}
	}
}

func (s *session) readLoop() {
	for {
		_, message, err := s.conn.Read(context.Background())
		if err != nil {
			s.close(err)
			return
		}
		typ, id, payload, err := decodeFrame(message)
		if err != nil {
			continue
		}
		s.mu.Lock()
		stream := s.streams[id]
		s.mu.Unlock()
		if stream == nil {
			continue
		}
		switch typ {
		case frameOpened:
			stream.handleOpened()
		case frameData:
			stream.handleData(payload)
		case frameWindow:
			if len(payload) >= 4 {
				stream.handleWindow(binary.BigEndian.Uint32(payload))
			}
		case frameFin:
			stream.handleFin()
		case frameReset:
			stream.handleReset(string(payload))
		}
	}
}

// pingLoop measures the round trip once a second while streams are open
// (the hub's heartbeat keeps an idle session alive).
func (s *session) pingLoop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
		}
		if s.activeStreams() == 0 {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		start := time.Now()
		err := s.conn.Ping(ctx)
		cancel()
		if err != nil {
			continue
		}
		rtt := time.Since(start)
		s.mu.Lock()
		if s.rttMin == 0 || rtt < s.rttMin {
			s.rttMin = rtt
		}
		if s.rttSmooth == 0 {
			s.rttSmooth = rtt
		} else {
			s.rttSmooth = (s.rttSmooth*3 + rtt) / 4
		}
		s.mu.Unlock()
	}
}

// openStream starts a stream: OPEN goes out at once, its bytes may follow
// before OPENED.
func (s *session) openStream() (*muxStream, error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, errSessionClosed
	}
	id := s.nextID
	s.nextID++
	stream := newMuxStream(s, id)
	s.streams[id] = stream
	s.mu.Unlock()
	if !s.enqueue(encodeFrame(frameOpen, id, nil), false) {
		return nil, errSessionClosed
	}
	return stream, nil
}

func (s *session) release(id uint32) {
	s.mu.Lock()
	delete(s.streams, id)
	if len(s.streams) == 0 {
		s.idleAt = time.Now()
	}
	s.mu.Unlock()
}

func (s *session) activeStreams() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.streams)
}

func (s *session) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// close ends the session and every stream on it
func (s *session) close(err error) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.err = err
	streams := s.streams
	s.streams = map[uint32]*muxStream{}
	s.queue = nil
	s.queueCond.Broadcast()
	s.mu.Unlock()
	close(s.done)
	for _, stream := range streams {
		stream.handleReset("session_closed")
	}
	s.conn.CloseNow()
}
