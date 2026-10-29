package tunnel

import (
	"context"
	"errors"
	"io"
	"syscall"
	"time"

	"github.com/coder/websocket"
)

// a hub under a burst of dials, or reloading, can reset a connection or
// close it before answering the upgrade: nothing went through the tunnel
// yet, so the dial is tried again. A refusal (an HTTP status, a closed port)
// is the answer and fails at once.
var dialRetryDelays = []time.Duration{
	50 * time.Millisecond,
	200 * time.Millisecond,
}

func dialHub(
	ctx context.Context,
	url string,
	opts *websocket.DialOptions,
) (*websocket.Conn, error) {
	for attempt := 0; ; attempt++ {
		c, _, err := websocket.Dial(ctx, url, opts)
		if err == nil || attempt == len(dialRetryDelays) || !transientDialError(err) {
			return c, err
		}

		select {
		case <-ctx.Done():
			return nil, err
		case <-time.After(dialRetryDelays[attempt]):
		}
	}
}

func transientDialError(err error) bool {
	return errors.Is(err, syscall.ECONNRESET) ||
		errors.Is(err, syscall.EPIPE) ||
		errors.Is(err, io.EOF) ||
		errors.Is(err, io.ErrUnexpectedEOF)
}
