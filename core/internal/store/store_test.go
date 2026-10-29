package store

import (
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/types"
	"testing"
	"time"
)

func streamResponse(closed *int) types.CoreCallResponse {
	return types.CoreCallResponse{
		Type: types.CoreResponseStream,
		Stream: &types.ResponseStream{
			Close: func(ctx *types.Context, streamId uint32) {
				*closed++
			},
		},
	}
}

func streamIdOf(t *testing.T, payload []byte) uint32 {
	if payload[0] != types.CoreResponseStream {
		t.Fatalf("expected a stream response, got %v", payload)
	}
	id, _ := serialization.Deserialize(payload, 1)
	return uint32(id.Data.(float64))
}

// a context holds more streams than one byte of ids (a pooled app: database
// and cache sockets, fetches), ids stay unique and skip 0 when they wrap
func TestStreamIdsPast255(t *testing.T) {
	dir := t.TempDir()
	ctxId := NewContext(dir, dir, true)
	t.Cleanup(func() { EndContext(ctxId) })
	ctx, _ := GetContext(ctxId)

	closed := 0
	ids := map[uint32]bool{}
	for i := 0; i < 1000; i++ {
		payload, err := BuildResponse(ctx, streamResponse(&closed))
		if err != nil {
			t.Fatal(err)
		}
		id := streamIdOf(t, payload)
		if id == 0 || ids[id] {
			t.Fatalf("stream %d got id %d", i, id)
		}
		ids[id] = true
	}

	// the last id, then the search wraps to the ids freed at the start
	ctx.StreamsMutex.Lock()
	delete(ctx.Streams, 1)
	ctx.NextStreamId = uint32(MaxStreamId)
	ctx.StreamsMutex.Unlock()

	payload, _ := BuildResponse(ctx, streamResponse(&closed))
	if id := streamIdOf(t, payload); id != uint32(MaxStreamId) {
		t.Fatalf("expected the last id, got %d", id)
	}
	payload, _ = BuildResponse(ctx, streamResponse(&closed))
	if id := streamIdOf(t, payload); id != 1 {
		t.Fatalf("expected id 1 after the wrap, got %d", id)
	}
}

// with all stream ids taken, a stream response is an error response (the
// producer closed) instead of a search that never ends
func TestStreamIdsExhausted(t *testing.T) {
	maxStreamId := MaxStreamId
	MaxStreamId = 255
	t.Cleanup(func() { MaxStreamId = maxStreamId })

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
