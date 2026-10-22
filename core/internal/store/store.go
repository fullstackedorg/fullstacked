package store

import (
	"errors"
	"fullstackedorg/fullstacked/internal/config"
	"fullstackedorg/fullstacked/internal/frames"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/types"
	"math"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

// ctxId, storedStreamId, size
var OnStreamData = (func(uint8, uint32, int))(nil)

var nextCtxId uint8 = 0
var Contexts = map[uint8]*types.Context{}
var ctxMutex = sync.Mutex{}

func NewContext(root string, build string, safe bool) uint8 {
	ctxMutex.Lock()

	id := nextCtxId

	_, ok := Contexts[id]
	for ok {
		id++
		_, ok = Contexts[id]
	}

	nextCtxId = id + 1

	ctxMutex.Unlock()

	NewContextWithCtxId(id, root, build, safe)
	return id
}

func NewContextWithCtxId(
	ctxId uint8,
	root string,
	build string,
	safe bool,
) {
	if strings.Compare(root, build) == 0 {
		build = filepath.Join(root, "out")
	}

	directories := types.ContextDirectories{
		Root:  root,
		Build: build,
	}

	ctx := &types.Context{
		Id:          ctxId,
		Directories: directories,

		Cwd: "/",

		Responses:      map[uint8][]byte{},
		ResponsesMutex: &sync.Mutex{},

		Streams:      map[uint32]*types.StoredStream{},
		StreamsMutex: &sync.Mutex{},

		Frames: frames.NewQueue(),

		NextStreamId: 1,

		Crypto:       map[uint32]any{},
		CryptoMutex:  &sync.Mutex{},
		NextCryptoId: 1,

		Zlib:       map[uint32]any{},
		ZlibMutex:  &sync.Mutex{},
		NextZlibId: 1,

		PendingDeepLinksMutex: &sync.Mutex{},
	}

	ctxMutex.Lock()
	Contexts[ctxId] = ctx
	ctxMutex.Unlock()

	if !safe {
		initialDirectory := config.GetConfig(ctx, "initialDirectory")
		if initialDirectory != "" {
			targetDir := filepath.Clean(filepath.Join(root, initialDirectory))
			NewContextWithCtxId(ctxId, targetDir, targetDir, safe)
		}
	}
}

func ExitContext(ctxId uint8) {
	ctxMutex.Lock()
	ctx, ok := Contexts[ctxId]

	if ok {
		ctx.Exited = true
	}

	ctxMutex.Unlock()

	go func() {
		time.Sleep(1 * time.Second)
		EndContext(ctxId)
	}()
}

// GetContext reads Contexts under ctxMutex, calls run concurrently with
// NewContext and EndContext
func GetContext(ctxId uint8) (*types.Context, bool) {
	ctxMutex.Lock()
	defer ctxMutex.Unlock()
	ctx, ok := Contexts[ctxId]
	return ctx, ok
}

func EndContext(ctxId uint8) {
	ctxMutex.Lock()

	ctx, ok := Contexts[ctxId]

	if ok {
		ctx.ResponsesMutex.Lock()
		ctx.Responses = nil
		ctx.ResponsesMutex.Unlock()

		ctx.Env = nil
		ctx.Plugins = nil
		ctx.GitAuths = nil
	}

	delete(Contexts, ctxId)

	ctxMutex.Unlock()

	if !ok {
		return
	}

	ctx.Frames.Close()

	// crypto handles hold no resources outside of memory
	ctx.CryptoMutex.Lock()
	ctx.Crypto = nil
	ctx.CryptoMutex.Unlock()

	// zlib decompression streams have a goroutine to stop
	ctx.ZlibMutex.Lock()
	zlibStreams := ctx.Zlib
	ctx.Zlib = nil
	ctx.ZlibMutex.Unlock()

	for _, s := range zlibStreams {
		if closer, ok := s.(interface{ Close() }); ok {
			closer.Close()
		}
	}

	// close streams outside of the locks, Close callbacks may stream
	ctx.StreamsMutex.Lock()
	streams := ctx.Streams
	ctx.Streams = nil
	ctx.StreamsMutex.Unlock()

	for i, stream := range streams {
		if stream.Close != nil {
			stream.Close(ctx, i)
		}
	}
}

func SetEnvironmentData(ctxId uint8, data map[string]string) {
	ctxMutex.Lock()
	defer ctxMutex.Unlock()

	ctx, ok := Contexts[ctxId]
	if !ok {
		return
	}

	ctx.Env = data
}

// StoreResponse keeps the response payload until the host fetches it with
// GetCorePayload, keyed by the request id
func StoreResponse(
	ctx *types.Context,
	header types.CoreCallHeader,
	response types.CoreCallResponse,
) (int, error) {
	payload, err := BuildResponse(ctx, response)
	if err != nil {
		return 0, err
	}

	ctx.ResponsesMutex.Lock()
	defer ctx.ResponsesMutex.Unlock()

	if ctx.Responses == nil {
		return 0, errors.New("context ended")
	}

	ctx.Responses[header.Id] = payload

	return len(payload), nil
}

// BuildResponse serializes the response payload, registering the stream
// of a stream response
func BuildResponse(
	ctx *types.Context,
	response types.CoreCallResponse,
) ([]byte, error) {
	switch response.Type {
	case types.CoreResponseError:
		return buildResponseData(response)
	case types.CoreResponseData:
		return buildResponseData(response)
	case types.CoreResponseStream:
		payload, err := buildResponseStream(ctx, response)
		if errors.Is(err, errNoStreamId) {
			// the call fails instead, releasing what the stream holds
			// (a socket, a request)
			if response.Stream.Close != nil {
				response.Stream.Close(ctx, 0)
			}
			return buildResponseData(types.CoreCallResponse{
				Type: types.CoreResponseError,
				Data: err.Error(),
			})
		}
		return payload, err
	}

	return nil, errors.New("unknown core response type")
}

var errNoStreamId = errors.New("too many open streams, no stream id free")

// stream ids are 1 to MaxStreamId, 0 is the hello and keepalive frames of
// package frames. The hosts take them as a signed 32 bit int (Java). A var
// for tests.
var MaxStreamId uint64 = math.MaxInt32

func wrapStreamId(id uint32) uint32 {
	if id == 0 || uint64(id) > MaxStreamId {
		return 1
	}
	return id
}

func buildResponseData(
	response types.CoreCallResponse,
) ([]byte, error) {
	payload := []byte{response.Type}

	if response.Data != nil {
		data, err := serialization.Serialize(response.Data)
		if err != nil {
			return nil, err
		}
		payload, err = serialization.MergeBuffers(payload, data)
		if err != nil {
			return nil, err
		}
	}

	return payload, nil
}

func buildResponseStream(
	ctx *types.Context,
	response types.CoreCallResponse,
) ([]byte, error) {
	ctx.StreamsMutex.Lock()
	defer ctx.StreamsMutex.Unlock()

	if response.Stream == nil {
		debug.PrintStack()
		return nil, errors.New("cannot store response stream with stream nil")
	}

	if ctx.Streams == nil {
		return nil, errors.New("context ended")
	}

	// the next free id from NextStreamId, one of the next len(Streams)+1 is
	// free; with every id taken the call fails, searching on would never end
	streamId := wrapStreamId(ctx.NextStreamId)
	free := false
	for range min(uint64(len(ctx.Streams))+1, MaxStreamId) {
		if ctx.Streams[streamId] == nil {
			free = true
			break
		}
		streamId = wrapStreamId(streamId + 1)
	}

	if !free {
		return nil, errNoStreamId
	}

	storedStreamId := streamId
	stored := &types.StoredStream{
		Open:       response.Stream.Open,
		Close:      response.Stream.Close,
		Write:      response.Stream.Write,
		WriteEvent: response.Stream.WriteEvent,
		Opened:     false,
		Ended:      false,
		Buffer:     []byte{},
	}
	if response.Stream.QueueWrites {
		stored.Writes = &types.StreamWrites{}
		stored.TryWrite = response.Stream.TryWrite
	}
	ctx.Streams[storedStreamId] = stored

	ctx.NextStreamId = wrapStreamId(storedStreamId + 1)

	payload := []byte{response.Type}
	storedStreamIdSerialized, err := serialization.Serialize(float64(storedStreamId))
	if err != nil {
		return nil, err
	}
	return serialization.MergeBuffers(payload, storedStreamIdSerialized)
}

/*
*
* 1 byte type
* n bytes data
*
 */

func GetCorePayload(
	ctxId uint8,
	coreType types.CoreCallResponseType,
	id uint32,
	size int,
) ([]byte, error) {
	ctx, ok := GetContext(ctxId)
	if !ok {
		return nil, errors.New("unkown context")
	}

	switch coreType {
	case types.CoreResponseData:
		// call ids are one byte
		if id > math.MaxUint8 {
			return nil, errors.New("cannot find response for id")
		}
		return getCorePayloadData(ctx, uint8(id))
	case types.CoreResponseStream:
		return getCorePayloadStream(ctx, id, size)
	}

	return nil, errors.New("unknown core type")
}
func getCorePayloadData(ctx *types.Context, id uint8) ([]byte, error) {
	ctx.ResponsesMutex.Lock()
	defer ctx.ResponsesMutex.Unlock()

	response, ok := ctx.Responses[id]
	if !ok {
		return nil, errors.New("cannot find response for id")
	}

	delete(ctx.Responses, id)

	return response, nil
}
func getCorePayloadStream(ctx *types.Context, id uint32, size int) ([]byte, error) {
	ctx.StreamsMutex.Lock()

	stream, ok := ctx.Streams[id]
	if !ok {
		ctx.StreamsMutex.Unlock()
		return nil, errors.New("cannot find stream for id")
	}

	if size <= 0 || len(stream.Buffer) < size-1 {
		ctx.StreamsMutex.Unlock()
		return nil, errors.New("stream buffer too small")
	}

	// a chunk and the end come from different goroutines (a read loop, the
	// page's close) and their reads can swap: the stream ends with the read
	// that takes its last bytes, never before, so no read finds it gone
	drained := len(stream.Buffer) == size-1

	var headerByte byte = 0
	if drained && stream.Error != nil {
		headerByte = 2
	} else if drained && stream.Ended {
		headerByte = 1
	} else if size == 1 && stream.Drains > 0 {
		// the read of a drain (StreamDrain) takes no data
		headerByte = frames.FlagDrain
		stream.Drains--
	}

	buffer, err := serialization.MergeBuffers([]byte{headerByte}, stream.Buffer[0:size-1])

	if err != nil {
		ctx.StreamsMutex.Unlock()
		return nil, err
	}

	stream.Buffer = stream.Buffer[size-1:]

	if headerByte == 1 || headerByte == 2 {
		delete(ctx.Streams, id)
	}
	ctx.StreamsMutex.Unlock()

	return buffer, nil
}

func StreamError(
	ctx *types.Context,
	storedStreamId uint32,
	err error,
) {
	ctxMutex.Lock()
	_, ok := Contexts[ctx.Id]
	ctxMutex.Unlock()

	if !ok {
		return
	}

	ctx.StreamsMutex.Lock()

	stream, ok := ctx.Streams[storedStreamId]

	// ended already (closed by the page), the error comes too late
	if !ok || stream.Ended {
		ctx.StreamsMutex.Unlock()
		return
	}

	if !stream.Opened {
		panic("streaming error for stream not opened")
	}

	stream.Ended = true
	var errMsg string
	if err != nil {
		stream.Error = err
		errMsg = err.Error()
	} else {
		errMsg = "unknown error"
	}

	if ctx.Frames.Attached() {
		delete(ctx.Streams, storedStreamId)
		ctx.StreamsMutex.Unlock()
		ctx.Frames.Push(storedStreamId, frames.FlagError, []byte(errMsg))
		return
	}

	stream.Buffer = []byte(errMsg)

	if OnStreamData == nil {
		panic("did not set OnStreamData")
	}

	ctx.StreamsMutex.Unlock()

	OnStreamData(ctx.Id, storedStreamId, len(errMsg)+1)
}

func StreamChunk(
	ctx *types.Context,
	storedStreamId uint32,
	buffer []byte,
	end bool,
) {
	ctxMutex.Lock()
	_, ok := Contexts[ctx.Id]
	ctxMutex.Unlock()

	if !ok {
		return
	}

	ctx.StreamsMutex.Lock()

	stream, ok := ctx.Streams[storedStreamId]
	framesAttached := ctx.Frames.Attached()

	// late chunks of an ended stream are dropped: the page closed it while
	// its read loop still had a chunk, or the context ended while streaming.
	// One end only, a second one would reach the page as a stray chunk.
	if !ok || stream.Ended {
		ctx.StreamsMutex.Unlock()
		return
	}

	if !stream.Opened {
		panic("streaming chunk for stream not opened")
	}

	// the host reads the frames, nothing is kept for GetCorePayload
	if framesAttached {
		flags := frames.FlagData
		if end {
			flags = frames.FlagEnd
			delete(ctx.Streams, storedStreamId)
		}
		ctx.StreamsMutex.Unlock()
		// waits while the reader catches up, outside of the streams lock
		ctx.Frames.Push(storedStreamId, flags, buffer)
		return
	}

	size := 0
	if buffer != nil {
		size = len(buffer)
		buf, err := serialization.MergeBuffers(stream.Buffer, buffer)
		if err != nil {
			panic(err)
		}
		stream.Buffer = buf
	}
	stream.Ended = end

	if OnStreamData == nil {
		panic("did not set OnStreamData")
	}

	ctx.StreamsMutex.Unlock()

	// add 1 to size for the done byte prepended in front
	OnStreamData(ctx.Id, storedStreamId, size+1)
}

func StreamEvent(
	ctx *types.Context,
	storedStreamId uint32,
	name string,
	data []types.SerializableData,
	end bool,
) {
	payload, err := serialization.Serialize(name)

	if err != nil {
		panic(err)
	}

	if len(data) > 0 {
		for _, d := range data {
			dataSerialized, err := serialization.Serialize(d)

			if err != nil {
				panic(err)
			}

			payload, err = serialization.MergeBuffers(payload, dataSerialized)

			if err != nil {
				panic(err)
			}
		}
	} else {
		nilSerialzied, err := serialization.Serialize(nil)

		if err != nil {
			panic(err)
		}

		payload, err = serialization.MergeBuffers(payload, nilSerialzied)

		if err != nil {
			panic(err)
		}
	}

	buffer, err := serialization.NumberToUint4Bytes(len(payload))

	if err != nil {
		panic(err)
	}

	buffer, err = serialization.MergeBuffers(buffer, payload)

	StreamChunk(ctx, storedStreamId, buffer, end)
}
