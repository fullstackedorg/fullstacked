// Package frames queues the stream data of a context for the host, which
// drains it into one long-lived binary response (GET /stream) instead of
// evaluating a script per chunk.
//
// Frame: [streamId u8][flags u8][length u32 big endian][data]
// flags: 0 data, 1 end, 2 error (data is the error message)
//
// The host attaches a reader with Attach, which returns a generation and
// queues a hello frame (stream 0, empty) so the page knows data flows. Read
// blocks until frames are queued and returns them all, whole frames only. A
// new Attach (page reload) or Detach ends the readers of older generations.
// While no reader is attached, the context uses the per chunk callback.
package frames

import (
	"encoding/binary"
	"sync"
	"time"
)

const (
	FlagData  uint8 = 0
	FlagEnd   uint8 = 1
	FlagError uint8 = 2

	HeaderSize = 6

	// producers wait while this much is queued and a reader is attached
	MaxQueued = 8 << 20
)

// Webviews (WebKit, Android WebView) hold the last bytes of a streaming
// response until more bytes arrive, which leaves the end of a stream with the
// host. Once the queue is idle after data, Read returns keepalive frames
// (stream 0, empty, like hello) at these delays to push the tail through,
// the first one soon since the tail waits for it.
var KeepaliveDelays = []time.Duration{
	1 * time.Millisecond,
	10 * time.Millisecond,
	100 * time.Millisecond,
	500 * time.Millisecond,
}

type Queue struct {
	mu       sync.Mutex
	cond     *sync.Cond
	buf      []byte
	gen      int
	attached bool
	closed   bool

	// keepalives returned since the last data, see KeepaliveDelays
	keepalives int
	// incremented by each keepalive timer that fires
	timeouts int
}

func NewQueue() *Queue {
	q := &Queue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

func Encode(dst []byte, streamId uint8, flags uint8, data []byte) []byte {
	var header [HeaderSize]byte
	header[0] = streamId
	header[1] = flags
	binary.BigEndian.PutUint32(header[2:], uint32(len(data)))
	dst = append(dst, header[:]...)
	return append(dst, data...)
}

// Attach makes the caller the only reader and queues the hello frame in
// front of the frames older readers left (whole frames, a reader that
// reconnects gets them). Returns the reader generation, 0 if closed.
func (q *Queue) Attach() int {
	q.mu.Lock()
	defer q.mu.Unlock()

	if q.closed {
		return 0
	}

	q.gen++
	q.attached = true
	q.buf = append(Encode(nil, 0, FlagData, nil), q.buf...)
	q.keepalives = 0
	q.cond.Broadcast()
	return q.gen
}

// Detach ends the reader of gen, or the current one for gen <= 0, chunks go
// back to the callback.
func (q *Queue) Detach(gen int) {
	q.mu.Lock()
	defer q.mu.Unlock()

	if gen <= 0 {
		gen = q.gen
	}

	if gen != q.gen {
		return
	}

	q.gen++
	q.attached = false
	q.buf = nil
	q.cond.Broadcast()
}

func (q *Queue) Attached() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.attached && !q.closed
}

// Read blocks until frames are queued for the reader of gen. Returns nil
// once that reader is replaced, detached or the queue closed.
func (q *Queue) Read(gen int) []byte {
	q.mu.Lock()
	defer q.mu.Unlock()

	for len(q.buf) == 0 && gen == q.gen && !q.closed {
		if q.keepalives >= len(KeepaliveDelays) {
			q.cond.Wait()
			continue
		}

		timeouts := q.timeouts
		timer := time.AfterFunc(KeepaliveDelays[q.keepalives], func() {
			q.mu.Lock()
			q.timeouts++
			q.cond.Broadcast()
			q.mu.Unlock()
		})
		q.cond.Wait()
		timer.Stop()

		if len(q.buf) == 0 && gen == q.gen && !q.closed && q.timeouts != timeouts {
			q.keepalives++
			return Encode(nil, 0, FlagData, nil)
		}
	}

	if gen != q.gen || q.closed {
		return nil
	}

	q.keepalives = 0
	out := q.buf
	q.buf = nil
	// wake producers waiting on a full queue
	q.cond.Broadcast()
	return out
}

// Push queues a frame, waiting while the queue is full. Returns false when
// no reader is attached, the caller then uses the callback.
func (q *Queue) Push(streamId uint8, flags uint8, data []byte) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	gen := q.gen
	for q.attached && !q.closed && gen == q.gen && len(q.buf) > MaxQueued {
		q.cond.Wait()
	}

	if !q.attached || q.closed || gen != q.gen {
		return false
	}

	q.buf = Encode(q.buf, streamId, flags, data)
	q.cond.Broadcast()
	return true
}

// Close ends the reader and the waiting producers, for good.
func (q *Queue) Close() {
	q.mu.Lock()
	defer q.mu.Unlock()

	q.closed = true
	q.attached = false
	q.buf = nil
	q.cond.Broadcast()
}
