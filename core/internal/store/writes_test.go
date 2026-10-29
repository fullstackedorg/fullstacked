package store

import (
	"bytes"
	"fullstackedorg/fullstacked/internal/frames"
	"fullstackedorg/fullstacked/types"
	"os"
	"sync"
	"testing"
	"time"
)

// the host's callback (without frames attached) for the whole package, a
// test sets what it calls: goroutines of an earlier test may still call it
var onStreamDataMutex sync.Mutex
var onStreamData func(uint8, uint32, int)

func TestMain(m *testing.M) {
	OnStreamData = func(ctxId uint8, streamId uint32, size int) {
		onStreamDataMutex.Lock()
		cb := onStreamData
		onStreamDataMutex.Unlock()
		if cb != nil {
			cb(ctxId, streamId, size)
		}
	}
	os.Exit(m.Run())
}

func setOnStreamData(t *testing.T, cb func(uint8, uint32, int)) {
	set := func(cb func(uint8, uint32, int)) {
		onStreamDataMutex.Lock()
		onStreamData = cb
		onStreamDataMutex.Unlock()
	}
	set(cb)
	t.Cleanup(func() { set(nil) })
}

// a stream whose writes wait for release, like a socket whose peer reads
// slowly
type slowStream struct {
	mu        sync.Mutex
	written   []byte
	writes    int
	release   chan struct{}
	closedAt  int
	closed    chan struct{}
	closeOnce sync.Once
}

func openSlowStream(t *testing.T) (*types.Context, uint32, *slowStream) {
	dir := t.TempDir()
	ctxId := NewContext(dir, dir, true)
	t.Cleanup(func() { EndContext(ctxId) })
	ctx, _ := GetContext(ctxId)

	s := &slowStream{release: make(chan struct{}), closed: make(chan struct{})}
	payload, err := BuildResponse(ctx, types.CoreCallResponse{
		Type: types.CoreResponseStream,
		Stream: &types.ResponseStream{
			QueueWrites: true,
			Write: func(ctx *types.Context, streamId uint32, data []byte) {
				<-s.release
				s.mu.Lock()
				s.written = append(s.written, data...)
				s.writes++
				s.mu.Unlock()
			},
			// again when the context ends
			Close: func(ctx *types.Context, streamId uint32) {
				s.closeOnce.Do(func() {
					s.mu.Lock()
					s.closedAt = len(s.written)
					s.mu.Unlock()
					close(s.closed)
				})
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	id := streamIdOf(t, payload)
	ctx.Streams[id].Opened = true
	return ctx, id, s
}

func frameFlags(buf []byte) []uint8 {
	flags := []uint8{}
	for len(buf) >= frames.HeaderSize {
		length := int(buf[5])<<24 | int(buf[6])<<16 | int(buf[7])<<8 | int(buf[8])
		if buf[0]|buf[1]|buf[2]|buf[3] != 0 {
			flags = append(flags, buf[4])
		}
		buf = buf[frames.HeaderSize+length:]
	}
	return flags
}

// a write returns while the peer takes nothing, in order once it does,
// joined when queued together; past the high water mark the call asks for
// a drain, which comes once the queue went down
func TestQueuedWrites(t *testing.T) {
	ctx, id, s := openSlowStream(t)
	stream := ctx.Streams[id]
	gen := ctx.Frames.Attach()
	ctx.Frames.Read(gen)

	returned := make(chan bool)
	go func() {
		wait := QueueWrite(ctx, id, stream, []byte("a"))
		wait = QueueWrite(ctx, id, stream, []byte("b")) || wait
		wait = QueueWrite(ctx, id, stream, []byte("c")) || wait
		returned <- wait
	}()
	select {
	case wait := <-returned:
		if wait {
			t.Fatal("3 bytes queued asked for a drain")
		}
	case <-time.After(time.Second):
		t.Fatal("a write waited for the peer")
	}

	big := bytes.Repeat([]byte{7}, WriteHighWater)
	if !QueueWrite(ctx, id, stream, big) {
		t.Fatal("past the high water mark the write did not ask for a drain")
	}

	close(s.release)
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		n := len(s.written)
		s.mu.Unlock()
		if n == 3+len(big) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("written %d bytes", n)
		}
		time.Sleep(time.Millisecond)
	}

	if !bytes.Equal(s.written[:3], []byte("abc")) || !bytes.Equal(s.written[3:], big) {
		t.Fatal("writes out of order")
	}
	// "a" alone (it started the goroutine), "bc" joined, the large write
	if s.writes > 3 {
		t.Fatalf("%d writes for 3 queued chunks and a large one", s.writes)
	}

	if flags := frameFlags(ctx.Frames.Read(gen)); len(flags) != 1 || flags[0] != frames.FlagDrain {
		t.Fatalf("expected one drain frame, got flags %v", flags)
	}
}

// a write larger than a batch goes in parts (one message each for a tunnel),
// the drain reaches a host without frames as a read of size 1 with flag 4,
// before the end
func TestQueuedWriteInParts(t *testing.T) {
	ctx, id, s := openSlowStream(t)

	headers := make(chan byte, 8)
	setOnStreamData(t, func(ctxId uint8, streamId uint32, size int) {
		payload, err := GetCorePayload(ctxId, types.CoreResponseStream, streamId, size)
		if err == nil {
			headers <- payload[0]
		}
	})
	close(s.release)

	size := 3*WriteBatchSize + 10
	data := make([]byte, size)
	for i := range data {
		data[i] = byte(i % 251)
	}
	QueueWrite(ctx, id, ctx.Streams[id], data)
	CloseStream(ctx, id)

	select {
	case <-s.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("not closed")
	}
	if !bytes.Equal(s.written, data) || s.writes != 4 {
		t.Fatalf("%d bytes in %d writes", len(s.written), s.writes)
	}

	for _, want := range []byte{frames.FlagDrain, frames.FlagEnd} {
		select {
		case header := <-headers:
			if header != want {
				t.Fatalf("header %d, want %d", header, want)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("no header %d", want)
		}
	}
}

// a close waits for the queued writes, later writes are dropped
func TestCloseAfterQueuedWrites(t *testing.T) {
	ctx, id, s := openSlowStream(t)
	stream := ctx.Streams[id]

	QueueWrite(ctx, id, stream, []byte("queued"))
	CloseStream(ctx, id)
	QueueWrite(ctx, id, stream, []byte("after close"))

	select {
	case <-s.closed:
		t.Fatal("closed before the queued write")
	case <-time.After(50 * time.Millisecond):
	}

	close(s.release)
	select {
	case <-s.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("not closed after the queued write")
	}

	if string(s.written) != "queued" || s.closedAt != len("queued") {
		t.Fatalf("written %q, closed at %d", s.written, s.closedAt)
	}
}
