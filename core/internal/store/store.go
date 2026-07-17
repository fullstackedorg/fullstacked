package store

import (
	"errors"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/types"
	"path"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

// ctxId, storedStreamId, size
var OnStreamData = (func(uint8, uint8, int))(nil)

var nextCtxId uint8 = 0
var Contexts = map[uint8]*types.Context{}
var ctxMutex = sync.Mutex{}

var CrashLogDir string

func NewContext(root string, build string) uint8 {
	ctxMutex.Lock()

	id := nextCtxId

	_, ok := Contexts[id]
	for ok {
		id++
		_, ok = Contexts[id]
	}

	nextCtxId = id + 1

	ctxMutex.Unlock()

	NewContextWithCtxId(id, root, build)
	return id
}

func NewContextWithCtxId(ctxId uint8, root string, build string) {
	ctxMutex.Lock()
	defer ctxMutex.Unlock()

	if strings.Compare(root, build) == 0 {
		build = path.Join(root, "out")
	}

	directories := types.ContextDirectories{
		Root:  root,
		Build: build,
	}

	CrashLogDir = root

	Contexts[ctxId] = &types.Context{
		Id:          ctxId,
		Directories: directories,

		Cwd: "/",

		Responses:      map[uint8][]byte{},
		ResponsesMutex: &sync.Mutex{},

		Streams:      map[uint8]*types.StoredStream{},
		StreamsMutex: &sync.Mutex{},

		NextStreamId: 1,
	}
}

func ExitContext(ctxId uint8) {
	ctxMutex.Lock()
	ctx, ok := Contexts[ctxId]

	if ok {
		ctx.Exit = true
	}

	ctxMutex.Unlock()

	go func() {
		time.Sleep(1 * time.Second)
		EndContext(ctxId)
	}()
}

func EndContext(ctxId uint8) {
	ctxMutex.Lock()

	ctx, ok := Contexts[ctxId]

	if ok {
		for i := range ctx.Streams {
			ctx.Streams[i].Close(ctx, i)
		}

		ctx.Responses = nil
		ctx.Streams = nil
		ctx.Env = nil
		ctx.Plugins = nil
		ctx.GitAuths = nil
	}

	delete(Contexts, ctxId)

	ctxMutex.Unlock()
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

func StoreResponse(
	ctx *types.Context,
	header types.CoreCallHeader,
	response types.CoreCallResponse,
) (int, error) {
	switch response.Type {
	case types.CoreResponseError:
		return storeResponseData(ctx, header, response)
	case types.CoreResponseData:
		return storeResponseData(ctx, header, response)
	case types.CoreResponseStream:
		return storeResponseStream(ctx, header, response)
	}

	return 0, errors.New("unknown core response type")
}

func storeResponseData(
	ctx *types.Context,
	header types.CoreCallHeader,
	response types.CoreCallResponse,
) (int, error) {
	ctx.ResponsesMutex.Lock()
	defer ctx.ResponsesMutex.Unlock()

	payload := []byte{response.Type}

	if response.Data != nil {
		data, err := serialization.Serialize(response.Data)
		if err != nil {
			return 0, err
		}
		payload, err = serialization.MergeBuffers(payload, data)
		if err != nil {
			return 0, err
		}
	}

	ctx.Responses[header.Id] = payload

	return len(payload), nil
}

func storeResponseStream(
	ctx *types.Context,
	header types.CoreCallHeader,
	response types.CoreCallResponse,
) (int, error) {
	ctx.StreamsMutex.Lock()
	defer ctx.StreamsMutex.Unlock()

	if response.Stream == nil {
		debug.PrintStack()
		return 0, errors.New("cannot store response stream with stream nil")
	}

	streamId := ctx.NextStreamId
	for {
		if streamId == 0 {
			streamId = 1
		}
		if ctx.Streams[streamId] == nil {
			break
		}
		streamId++
	}

	storedStreamId := streamId
	ctx.Streams[storedStreamId] = &types.StoredStream{
		Open:       response.Stream.Open,
		Close:      response.Stream.Close,
		Write:      response.Stream.Write,
		WriteEvent: response.Stream.WriteEvent,
		Opened:     false,
		Ended:      false,
		Buffer:     []byte{},
	}

	ctx.NextStreamId = storedStreamId + 1
	if ctx.NextStreamId == 0 {
		ctx.NextStreamId = 1
	}

	payload := []byte{response.Type}
	storedStreamIdSerialized, err := serialization.Serialize(float64(storedStreamId))
	if err != nil {
		return 0, err
	}
	payload, err = serialization.MergeBuffers(payload, storedStreamIdSerialized)
	if err != nil {
		return 0, err
	}

	ctx.ResponsesMutex.Lock()
	defer ctx.ResponsesMutex.Unlock()

	ctx.Responses[header.Id] = payload

	return len(payload), nil
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
	id uint8,
	size int,
) ([]byte, error) {
	ctxMutex.Lock()
	ctx, ok := Contexts[ctxId]
	ctxMutex.Unlock()

	if !ok {
		return nil, errors.New("unkown context")
	}

	switch coreType {
	case types.CoreResponseData:
		return getCorePayloadData(ctx, id)
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
func getCorePayloadStream(ctx *types.Context, id uint8, size int) ([]byte, error) {
	ctx.StreamsMutex.Lock()

	stream, ok := ctx.Streams[id]
	if !ok {
		ctx.StreamsMutex.Unlock()
		return nil, errors.New("cannot find stream for id")
	}

	var headerByte byte = 0
	if stream.Error != nil {
		headerByte = 2
	} else if stream.Ended {
		headerByte = 1
	}

	buffer, err := serialization.MergeBuffers([]byte{headerByte}, stream.Buffer[0:size-1])

	if err != nil {
		ctx.StreamsMutex.Unlock()
		return nil, err
	}

	stream.Buffer = stream.Buffer[size-1:]

	if stream.Error != nil || stream.Ended {
		delete(ctx.Streams, id)
	}
	ctx.StreamsMutex.Unlock()

	return buffer, nil
}

func StreamError(
	ctx *types.Context,
	storedStreamId uint8,
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

	if !ok {
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
	stream.Buffer = []byte(errMsg)

	if OnStreamData == nil {
		panic("did not set OnStreamData")
	}

	ctx.StreamsMutex.Unlock()

	OnStreamData(ctx.Id, storedStreamId, len(errMsg)+1)
}

func StreamChunk(
	ctx *types.Context,
	storedStreamId uint8,
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

	if !ok {
		if len(buffer) > 0 || !end {
			panic("no stream for id")
		} else {
			ctx.StreamsMutex.Unlock()
			return
		}
	}

	if !stream.Opened {
		panic("streaming chunk for stream not opened")
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
	storedStreamId uint8,
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
