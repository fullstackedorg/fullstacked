package store

import (
	"testing"
	"time"
)

// writes wait for the dial and get the socket
func TestDialingWaitsForTheDial(t *testing.T) {
	d := NewDialing[string]()
	got := make(chan string, 1)
	go func() {
		conn, ok := d.Wait()
		if ok {
			got <- conn
		} else {
			got <- "not dialed"
		}
	}()

	select {
	case <-got:
		t.Fatal("a write went before the dial")
	case <-time.After(20 * time.Millisecond):
	}

	if !d.Dialed("socket") {
		t.Fatal("dial refused on an open stream")
	}
	if conn := <-got; conn != "socket" {
		t.Fatalf("got %q", conn)
	}
	if _, ok := d.Close(); !ok {
		t.Fatal("close did not return the socket to close")
	}
}

// a close during the dial: the dialed socket is refused (the dialer closes
// it), waiting writes are released
func TestDialingClosedDuringTheDial(t *testing.T) {
	d := NewDialing[string]()
	released := make(chan bool, 1)
	go func() {
		_, ok := d.Wait()
		released <- ok
	}()

	if _, ok := d.Close(); ok {
		t.Fatal("nothing dialed yet, nothing to close")
	}
	if ok := <-released; ok {
		t.Fatal("a write got a socket after the close")
	}
	if d.Dialed("socket") {
		t.Fatal("a socket dialed after the close was kept")
	}
}

// a failed dial releases waiting writes
func TestDialingFailed(t *testing.T) {
	d := NewDialing[string]()
	released := make(chan bool, 1)
	go func() {
		_, ok := d.Wait()
		released <- ok
	}()
	d.Failed()
	if ok := <-released; ok {
		t.Fatal("a write got a socket after a failed dial")
	}
}
