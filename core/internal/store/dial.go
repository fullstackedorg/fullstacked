package store

import "sync"

// Dialing holds the socket of a stream that dials in its Open, off the
// bridge call (net and tunnel connects): on hosts that run calls on the
// page's thread (Node) or one after the other (webviews), a dial in the call
// made concurrent connects wait for each other and held up every other
// socket for the length of each dial. Writes wait for the dial, a close
// during it closes the socket as soon as it is dialed.
type Dialing[C any] struct {
	mu     sync.Mutex
	conn   C
	ok     bool
	closed bool
	done   chan struct{}
	once   sync.Once
}

func NewDialing[C any]() *Dialing[C] {
	return &Dialing[C]{done: make(chan struct{})}
}

// Dialed records the socket once dialed. False when the stream closed
// meanwhile: the caller closes the socket and stops.
func (d *Dialing[C]) Dialed(conn C) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	defer d.once.Do(func() { close(d.done) })
	if d.closed {
		return false
	}
	d.conn = conn
	d.ok = true
	return true
}

// Failed releases the writes waiting for a dial that failed
func (d *Dialing[C]) Failed() {
	d.once.Do(func() { close(d.done) })
}

// Wait returns the socket once dialed, false when the dial failed or the
// stream closed
func (d *Dialing[C]) Wait() (C, bool) {
	<-d.done
	return d.Ready()
}

// Ready returns the socket if dialed, without waiting
func (d *Dialing[C]) Ready() (C, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.conn, d.ok && !d.closed
}

// Close marks the stream closed and returns the socket to close, if dialed
func (d *Dialing[C]) Close() (C, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.once.Do(func() { close(d.done) })
	d.closed = true
	return d.conn, d.ok
}
