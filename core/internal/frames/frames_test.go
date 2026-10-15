package frames

import (
	"bytes"
	"testing"
	"time"
)

func TestHelloAndFrames(t *testing.T) {
	q := NewQueue()

	if q.Push(1, FlagData, []byte("x")) {
		t.Fatal("push without reader should fall back to the callback")
	}

	gen := q.Attach()
	if !q.Attached() {
		t.Fatal("not attached")
	}

	hello := q.Read(gen)
	if !bytes.Equal(hello, []byte{0, 0, 0, 0, 0, 0}) {
		t.Fatalf("hello frame %v", hello)
	}

	q.Push(3, FlagData, []byte("ab"))
	q.Push(3, FlagEnd, nil)

	got := q.Read(gen)
	want := []byte{3, 0, 0, 0, 0, 2, 'a', 'b', 3, 1, 0, 0, 0, 0}
	if !bytes.Equal(got, want) {
		t.Fatalf("frames %v, want %v", got, want)
	}
}

func withoutKeepalives(t *testing.T) {
	delays := KeepaliveDelays
	KeepaliveDelays = nil
	t.Cleanup(func() { KeepaliveDelays = delays })
}

func TestKeepalives(t *testing.T) {
	delays := KeepaliveDelays
	KeepaliveDelays = []time.Duration{5 * time.Millisecond, 10 * time.Millisecond}
	t.Cleanup(func() { KeepaliveDelays = delays })

	q := NewQueue()
	gen := q.Attach()
	q.Read(gen)

	// one keepalive per delay after data, then the reader waits for data
	for i := range KeepaliveDelays {
		if b := q.Read(gen); !bytes.Equal(b, []byte{0, 0, 0, 0, 0, 0}) {
			t.Fatalf("keepalive %d: %v", i, b)
		}
	}

	read := make(chan []byte)
	go func() { read <- q.Read(gen) }()
	select {
	case b := <-read:
		t.Fatalf("read %v without data", b)
	case <-time.After(50 * time.Millisecond):
	}

	q.Push(1, FlagData, []byte("z"))
	if b := <-read; len(b) != HeaderSize+1 {
		t.Fatalf("read %v", b)
	}

	// data resets the keepalives
	if b := q.Read(gen); len(b) != HeaderSize {
		t.Fatalf("keepalive after data: %v", b)
	}
}

func TestReattachEndsOldReader(t *testing.T) {
	withoutKeepalives(t)
	q := NewQueue()
	old := q.Attach()
	q.Read(old)

	done := make(chan []byte)
	go func() { done <- q.Read(old) }()

	gen := q.Attach()
	select {
	case b := <-done:
		if b != nil {
			t.Fatalf("old reader got %v", b)
		}
	case <-time.After(time.Second):
		t.Fatal("old reader still blocked")
	}

	// the new reader starts with its own hello
	if b := q.Read(gen); len(b) != HeaderSize {
		t.Fatalf("new reader got %v", b)
	}
}

func TestDetachAndClose(t *testing.T) {
	q := NewQueue()
	gen := q.Attach()
	q.Read(gen)
	q.Detach(gen)
	if q.Attached() || q.Read(gen) != nil {
		t.Fatal("detached reader should end")
	}

	gen = q.Attach()
	q.Close()
	if q.Read(gen) != nil || q.Attach() != 0 || q.Push(1, FlagData, nil) {
		t.Fatal("closed queue should refuse readers and frames")
	}
}

func TestBackpressure(t *testing.T) {
	q := NewQueue()
	gen := q.Attach()
	q.Read(gen)

	big := make([]byte, MaxQueued+1)
	q.Push(1, FlagData, big)

	pushed := make(chan bool)
	go func() { pushed <- q.Push(1, FlagData, []byte("y")) }()

	select {
	case <-pushed:
		t.Fatal("push should wait while the queue is full")
	case <-time.After(50 * time.Millisecond):
	}

	if b := q.Read(gen); len(b) != HeaderSize+len(big) {
		t.Fatalf("read %d bytes", len(b))
	}
	if !<-pushed {
		t.Fatal("push should resume once drained")
	}
}

func TestReattachKeepsQueuedFrames(t *testing.T) {
	withoutKeepalives(t)
	q := NewQueue()
	old := q.Attach()
	q.Read(old)
	q.Push(2, FlagData, []byte("q"))

	// the reader reconnects before reading the frame
	gen := q.Attach()
	want := append(Encode(nil, 0, FlagData, nil), Encode(nil, 2, FlagData, []byte("q"))...)
	if b := q.Read(gen); !bytes.Equal(b, want) {
		t.Fatalf("read %v, want %v", b, want)
	}

	// 0 detaches the current reader
	q.Detach(0)
	if q.Attached() {
		t.Fatal("still attached")
	}
}

func TestKeepaliveRightAfterResponse(t *testing.T) {
	delays := KeepaliveDelays
	KeepaliveDelays = []time.Duration{time.Hour}
	t.Cleanup(func() { KeepaliveDelays = delays })

	q := NewQueue()
	gen := q.Attach()
	q.Read(gen)

	// data: the keepalive waits for its delay
	q.Push(1, FlagData, []byte("a"))
	q.Read(gen)
	read := make(chan []byte, 1)
	go func() { read <- q.Read(gen) }()
	select {
	case b := <-read:
		t.Fatalf("keepalive after data: %v", b)
	case <-time.After(50 * time.Millisecond):
	}
	q.Push(1, FlagResponse, []byte("r"))
	<-read

	// a response: the keepalive comes right away
	if b := q.Read(gen); len(b) != HeaderSize {
		t.Fatalf("no keepalive right after the response: %v", b)
	}
}
