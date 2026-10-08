package router

import (
	"bytes"
	"encoding/binary"
	"fullstackedorg/fullstacked/internal/frames"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/internal/stream"
	"fullstackedorg/fullstacked/internal/test"
	"fullstackedorg/fullstacked/types"
	"testing"
)

func call(t *testing.T, ctx uint8, module types.CoreModule, fn uint8, data ...types.SerializableData) []byte {
	payload := []byte{ctx, 0, module, fn, 0}
	for _, d := range data {
		serialized, err := serialization.Serialize(d)
		if err != nil {
			t.Fatal(err)
		}
		payload = append(payload, serialized...)
	}
	response, err := CallWithResponse(payload)
	if err != nil {
		t.Fatal(err)
	}
	if response[0] == types.CoreResponseError {
		t.Fatalf("core error %v", response)
	}
	return response
}

type frame struct {
	streamId uint8
	flags    uint8
	data     []byte
}

func parseFrames(t *testing.T, buf []byte) []frame {
	parsed := []frame{}
	for len(buf) > 0 {
		if len(buf) < frames.HeaderSize {
			t.Fatalf("partial header %v", buf)
		}
		length := int(binary.BigEndian.Uint32(buf[2:6]))
		// stream 0 is hello and keepalives
		if buf[0] != 0 {
			parsed = append(parsed, frame{buf[0], buf[1], buf[6 : 6+length]})
		}
		buf = buf[6+length:]
	}
	return parsed
}

// a stream opened while a reader is attached arrives as frames, in order,
// ending with an end frame
func TestStreamFrames(t *testing.T) {
	ctxId := store.NewContext(t.TempDir(), t.TempDir(), true)
	defer store.EndContext(ctxId)
	ctx, _ := store.GetContext(ctxId)

	gen := ctx.Frames.Attach()
	hello := ctx.Frames.Read(gen)
	if !bytes.Equal(hello, []byte{0, 0, 0, 0, 0, 0}) {
		t.Fatalf("hello %v", hello)
	}

	response := call(t, ctxId, types.Test, test.BenchStream, float64(10), float64(4))
	if response[0] != types.CoreResponseStream {
		t.Fatalf("not a stream response %v", response)
	}
	streamId, err := serialization.Deserialize(response, 1)
	if err != nil {
		t.Fatal(err)
	}
	call(t, ctxId, types.Stream, stream.Open, streamId.Data)

	received := []frame{}
	for len(received) == 0 || received[len(received)-1].flags == frames.FlagData {
		received = append(received, parseFrames(t, ctx.Frames.Read(gen))...)
	}

	sizes := []int{}
	for i, f := range received {
		if f.streamId != uint8(streamId.Data.(float64)) {
			t.Fatalf("frame %d of stream %d", i, f.streamId)
		}
		sizes = append(sizes, len(f.data))
	}
	if len(sizes) != 3 || sizes[0] != 4 || sizes[1] != 4 || sizes[2] != 2 {
		t.Fatalf("chunk sizes %v", sizes)
	}
	if received[2].flags != frames.FlagEnd {
		t.Fatalf("last frame flags %d", received[2].flags)
	}

	// ended streams are dropped right away
	ctx.StreamsMutex.Lock()
	remaining := len(ctx.Streams)
	ctx.StreamsMutex.Unlock()
	if remaining != 0 {
		t.Fatalf("%d streams left", remaining)
	}
}

// ending the context ends the reader
func TestStreamFramesEndContext(t *testing.T) {
	ctxId := store.NewContext(t.TempDir(), t.TempDir(), true)
	ctx, _ := store.GetContext(ctxId)
	gen := ctx.Frames.Attach()
	ctx.Frames.Read(gen)

	store.EndContext(ctxId)
	if ctx.Frames.Read(gen) != nil {
		t.Fatal("reader should end with the context")
	}
}
