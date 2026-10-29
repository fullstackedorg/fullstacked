package zlib

import (
	"io"
	"sync"
)

// feed runs a decoder over input pushed chunk by chunk. Go's decompressors
// pull from an io.Reader, Node's streams push: the decoder runs on its own
// goroutine and reads the feed, push hands it a chunk and waits until the
// decoder has taken every byte of it and waits for more (or has stopped),
// so a push returns exactly the output its input allows. That is what ssh2
// needs: each packet, flushed by the sender, decodes before the next one
// arrives.
//
// The goroutine starts on the first push and ends with the data, an error,
// or stop (StreamEnd, Free, EndContext).
type feed struct {
	mu   sync.Mutex
	cond *sync.Cond

	// set by push, taken by the decoder
	next    []byte
	hasNext bool
	eof     bool // no more input: the end of the data is the end of the input
	stopped bool // the decoder must give up at its next read

	waiting bool  // the decoder took everything and waits
	done    bool  // the decoder returned
	err     error // what it returned
	out     []byte

	// owned by the decoder goroutine: the chunk being read and the hook
	// that hands out what the decoder holds before the feed waits
	cur      []byte
	flushing func()
}

func newFeed() *feed {
	f := &feed{}
	f.cond = sync.NewCond(&f.mu)
	return f
}

// start runs decode on its goroutine, reading from the feed
func (f *feed) start(decode func(in input, out io.Writer) error) {
	go func() {
		err := decode(f, f)
		f.mu.Lock()
		f.done = true
		f.err = err
		f.cond.Broadcast()
		f.mu.Unlock()
	}()
}

// push hands p to the decoder and returns the output produced since the
// last push. The decoder only reads p while push waits: p may alias the
// call payload. With end, the input ends after p and push waits for the
// decoder to return.
func (f *feed) push(p []byte, end bool) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	if !f.done {
		if len(p) > 0 {
			f.next = p
			f.hasNext = true
		}
		if end {
			f.eof = true
		}
		f.cond.Broadcast()
		for !f.done && (f.hasNext || !f.waiting || f.eof) {
			f.cond.Wait()
		}
	}
	// the decoder no longer holds p
	f.next = nil
	f.hasNext = false

	out := f.out
	f.out = nil
	return out, f.err
}

// stop makes the decoder goroutine return at its next read (it is waiting
// for input whenever no push is in progress); it does not wait for it
func (f *feed) stop() {
	f.mu.Lock()
	f.stopped = true
	f.cond.Broadcast()
	f.mu.Unlock()
}

// Write collects the decoder's output, on the decoder goroutine
func (f *feed) Write(p []byte) (int, error) {
	f.mu.Lock()
	f.out = append(f.out, p...)
	f.mu.Unlock()
	return len(p), nil
}

func (f *feed) onWait(flushing func()) {
	f.flushing = flushing
}

func (f *feed) ReadByte() (byte, error) {
	if len(f.cur) == 0 {
		if err := f.fill(); err != nil {
			return 0, err
		}
	}
	b := f.cur[0]
	f.cur = f.cur[1:]
	return b, nil
}

func (f *feed) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if len(f.cur) == 0 {
		if err := f.fill(); err != nil {
			return 0, err
		}
	}
	n := copy(p, f.cur)
	f.cur = f.cur[n:]
	return n, nil
}

// fill takes the next chunk, waiting for a push when there is none: the
// only place the decoder goroutine blocks
func (f *feed) fill() error {
	f.mu.Lock()
	if !f.hasNext && !f.eof && !f.stopped && f.flushing != nil {
		// Write takes the lock
		f.mu.Unlock()
		f.flushing()
		f.mu.Lock()
	}
	defer f.mu.Unlock()
	for {
		switch {
		case f.stopped:
			return errStopped
		case f.hasNext:
			f.cur = f.next
			f.next = nil
			f.hasNext = false
			return nil
		case f.eof:
			return io.EOF
		}
		f.waiting = true
		f.cond.Broadcast()
		f.cond.Wait()
		f.waiting = false
	}
}
