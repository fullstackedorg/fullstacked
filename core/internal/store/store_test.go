package store

import (
	"fullstackedorg/fullstacked/types"
	"testing"
	"time"
)

func streamResponse(closed *int) types.CoreCallResponse {
	return types.CoreCallResponse{
		Type: types.CoreResponseStream,
		Stream: &types.ResponseStream{
			Close: func(ctx *types.Context, streamId uint8) {
				*closed++
			},
		},
	}
}

// with all 255 stream ids taken, a stream response is an error response
// (the producer closed) instead of a search that never ends
func TestStreamIdsExhausted(t *testing.T) {
	dir := t.TempDir()
	ctxId := NewContext(dir, dir, true)
	t.Cleanup(func() { EndContext(ctxId) })
	ctx, _ := GetContext(ctxId)

	closed := 0
	for i := 0; i < 255; i++ {
		payload, err := BuildResponse(ctx, streamResponse(&closed))
		if err != nil || payload[0] != types.CoreResponseStream {
			t.Fatalf("stream %d: %v %v", i, payload, err)
		}
	}

	done := make(chan []byte)
	go func() {
		payload, _ := BuildResponse(ctx, streamResponse(&closed))
		done <- payload
	}()

	select {
	case payload := <-done:
		if payload[0] != types.CoreResponseError {
			t.Fatalf("expected an error response, got %v", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("stream id search did not return")
	}

	if closed != 1 {
		t.Fatalf("the refused stream was closed %d times", closed)
	}

	// an id frees up, the next stream takes it
	ctx.StreamsMutex.Lock()
	delete(ctx.Streams, 42)
	ctx.StreamsMutex.Unlock()

	payload, err := BuildResponse(ctx, streamResponse(&closed))
	if err != nil || payload[0] != types.CoreResponseStream {
		t.Fatalf("freed id: %v %v", payload, err)
	}
}
