package store

import (
	"bytes"
	"fullstackedorg/fullstacked/internal/frames"
	"fullstackedorg/fullstacked/types"
	"slices"
)

// The writes of a stream with types.ResponseStream.QueueWrites (sockets,
// tunnel connections) are done in order by a goroutine of the stream. The
// write call returns at once: on hosts that run calls on the page's thread
// (Node) or one after the other (webviews), a peer slow to take the data
// blocked every other call. Past WriteHighWater queued, the call answers
// that the page waits for a drain (frames.FlagDrain), sent once the queue is
// down to WriteLowWater.
const (
	WriteHighWater = 1 << 20
	WriteLowWater  = 256 << 10
	// queued chunks are joined up to this: one write, one message for a
	// tunnel
	WriteBatchSize = 1 << 20
)

// QueueWrite queues data for the goroutine of the stream. Returns true when
// the page should wait for a drain before writing more.
func QueueWrite(
	ctx *types.Context,
	streamId uint32,
	stream *types.StoredStream,
	data []byte,
) bool {
	w := stream.Writes
	w.Mutex.Lock()
	defer w.Mutex.Unlock()

	// after the close, dropped like a write to a closed socket
	if w.Closed {
		return false
	}

	// nothing queued: what the socket takes now goes without the goroutine
	if !w.Writing && stream.TryWrite != nil {
		data = data[stream.TryWrite(ctx, streamId, data):]
		if len(data) == 0 {
			return false
		}
	}

	w.Chunks = append(w.Chunks, data)
	w.Queued += len(data)
	if !w.Writing {
		w.Writing = true
		go writeQueued(ctx, streamId, stream)
	}

	if w.Queued > WriteHighWater {
		w.DrainRequested = true
		return true
	}
	return false
}

func writeQueued(ctx *types.Context, streamId uint32, stream *types.StoredStream) {
	w := stream.Writes
	for {
		w.Mutex.Lock()
		if len(w.Chunks) == 0 {
			w.Writing = false
			closed := w.Closed
			w.Mutex.Unlock()
			// a close came while writing, it waited for the queued writes
			if closed {
				closeStreamNow(ctx, streamId, stream)
			}
			return
		}

		var data []byte
		if first := w.Chunks[0]; len(first) > WriteBatchSize {
			// a large write goes in parts: a tunnel hub forwards a message
			// once it has all of it
			data = first[:WriteBatchSize]
			w.Chunks[0] = first[WriteBatchSize:]
			w.Mutex.Unlock()
		} else {
			size := len(first)
			n := 1
			for n < len(w.Chunks) && size+len(w.Chunks[n]) <= WriteBatchSize {
				size += len(w.Chunks[n])
				n++
			}
			chunks := slices.Clone(w.Chunks[:n])
			clear(w.Chunks[:n])
			w.Chunks = w.Chunks[n:]
			w.Mutex.Unlock()

			data = chunks[0]
			if n > 1 {
				data = bytes.Join(chunks, nil)
			}
		}
		size := len(data)
		stream.Write(ctx, streamId, data)

		w.Mutex.Lock()
		w.Queued -= size
		drain := w.DrainRequested && w.Queued <= WriteLowWater
		if drain {
			w.DrainRequested = false
		}
		w.Mutex.Unlock()

		if drain {
			StreamDrain(ctx, streamId)
		}
	}
}

// CloseStream closes a stream for the page (its producer: a socket, a
// request) and ends it. Writes still queued are done first, the goroutine
// writing them closes the stream after.
func CloseStream(ctx *types.Context, streamId uint32) {
	ctx.StreamsMutex.Lock()
	stream, ok := ctx.Streams[streamId]
	ctx.StreamsMutex.Unlock()

	if !ok {
		return
	}

	if w := stream.Writes; w != nil {
		w.Mutex.Lock()
		closed := w.Closed
		w.Closed = true
		writing := w.Writing
		w.Mutex.Unlock()

		if closed || writing {
			return
		}
	}

	closeStreamNow(ctx, streamId, stream)
}

func closeStreamNow(ctx *types.Context, streamId uint32, stream *types.StoredStream) {
	if stream.Close != nil {
		stream.Close(ctx, streamId)
	}

	StreamChunk(ctx, streamId, nil, true)
}

// StreamDrain tells the page it may write to the stream again, an empty
// chunk with the drain flag
func StreamDrain(ctx *types.Context, streamId uint32) {
	if _, ok := GetContext(ctx.Id); !ok {
		return
	}

	ctx.StreamsMutex.Lock()

	stream, ok := ctx.Streams[streamId]
	if !ok || stream.Ended {
		ctx.StreamsMutex.Unlock()
		return
	}

	if ctx.Frames.Attached() {
		ctx.StreamsMutex.Unlock()
		ctx.Frames.Push(streamId, frames.FlagDrain, nil)
		return
	}

	// the read of size 1 takes no data, see getCorePayloadStream
	stream.Drains++

	if OnStreamData == nil {
		panic("did not set OnStreamData")
	}

	ctx.StreamsMutex.Unlock()

	OnStreamData(ctx.Id, streamId, 1)
}
