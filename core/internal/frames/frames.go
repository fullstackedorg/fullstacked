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
)

const (
	FlagData  uint8 = 0
	FlagEnd   uint8 = 1
	FlagError uint8 = 2

	HeaderSize = 6

	// producers wait while this much is queued and a reader is attached
	MaxQueued = 8 << 20
)

type Queue struct {
	mu       sync.Mutex
	cond     *sync.Cond
	buf      []byte
	gen      int
	attached bool
	closed   bool
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

// Attach makes the caller the only reader, drops what older readers left
// and queues the hello frame. Returns the reader generation, 0 if closed.
func (q *Queue) Attach() int {
	q.mu.Lock()
	defer q.mu.Unlock()

	if q.closed {
		return 0
	}

	q.gen++
	q.attached = true
	q.buf = Encode(nil, 0, FlagData, nil)
	q.cond.Broadcast()
	return q.gen
}

// Detach ends the reader of gen, chunks go back to the callback.
func (q *Queue) Detach(gen int) {
	q.mu.Lock()
	defer q.mu.Unlock()

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
		q.cond.Wait()
	}

	if gen != q.gen || q.closed {
		return nil
	}

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
