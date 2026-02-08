package store

import (
	"errors"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/types"
	"sync"
)

// ctxId, storedStreamId, size
var OnStreamData = (func(uint8, uint8, int))(nil)

var ctxCount = 0
var Contexts = map[uint8]types.CoreCallContext{}
var ctxMutex = sync.Mutex{}

func NewContext(directory string) uint8 {
	ctxMutex.Lock()
	id := uint8(ctxCount % 256)
	Contexts[id] = types.CoreCallContext{
		Id:            id,
		BaseDirectory: directory,

		Responses:      map[uint8][]byte{},
		ResponsesMutex: &sync.Mutex{},

		Streams:      map[uint8]*types.StoredStream{},
		StreamsMutex: &sync.Mutex{},
	}
	ctxCount++
	ctxMutex.Unlock()

	return id
}

func StoreResponse(
	ctx *types.CoreCallContext,
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
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	response types.CoreCallResponse,
) (int, error) {
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

	ctx.ResponsesMutex.Lock()
	ctx.Responses[header.Id] = payload
	ctx.ResponsesMutex.Unlock()

	return len(payload), nil
}

func storeResponseStream(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	response types.CoreCallResponse,
) (int, error) {
	if response.Stream == nil {
		return 0, errors.New("cannot store response stream with stream nil")
	}

	streamId := uint8(1)
	for ctx.Streams[streamId] != nil {
		streamId++
	}

	ctx.StreamsMutex.Lock()
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
	ctx.StreamsMutex.Unlock()

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
	ctx.Responses[header.Id] = payload
	ctx.ResponsesMutex.Unlock()

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
) ([]byte, error) {
	ctxMutex.Lock()
	ctx, ok := Contexts[ctxId]
	ctxMutex.Unlock()

	if !ok {
		return nil, errors.New("unkown context")
	}

	switch coreType {
	case types.CoreResponseData:
		return getCorePayloadData(&ctx, id)
	case types.CoreResponseStream:
		return getCorePayloadStream(&ctx, id)
	}

	return nil, errors.New("unknown core type")
}
func getCorePayloadData(ctx *types.CoreCallContext, id uint8) ([]byte, error) {
	ctx.ResponsesMutex.Lock()
	response, ok := ctx.Responses[id]
	ctx.ResponsesMutex.Unlock()

	if !ok {
		return nil, errors.New("cannot find response for id")
	}

	defer func() {
		ctx.ResponsesMutex.Lock()
		delete(ctx.Responses, id)
		ctx.ResponsesMutex.Unlock()
	}()

	return response, nil
}
func getCorePayloadStream(ctx *types.CoreCallContext, id uint8) ([]byte, error) {
	ctx.StreamsMutex.Lock()

	stream, ok := ctx.Streams[id]
	if !ok {
		return nil, errors.New("cannot find stream for id")
	}

	buffer, err := serialization.MergeBuffers([]byte{0}, stream.Buffer)

	if err != nil {
		return nil, err
	}

	if stream.Ended {
		buffer[0] = 1
		defer func() {
			ctx.StreamsMutex.Lock()
			delete(ctx.Streams, id)
			ctx.StreamsMutex.Unlock()
		}()
	}

	stream.Buffer = []byte{}

	ctx.StreamsMutex.Unlock()

	return buffer, nil
}

func StreamChunk(
	ctx *types.CoreCallContext,
	storedStreamId uint8,
	buffer []byte,
	end bool,
) {
	ctx.StreamsMutex.Lock()
	stream, ok := ctx.Streams[storedStreamId]
	ctx.StreamsMutex.Unlock()

	if !ok {
		if len(buffer) > 0 || !end {
			panic("no stream for id")
		} else {
			return
		}
	}

	if !stream.Opened {
		panic("streaming chunk for stream not opened")
	}

	size := 0
	ctx.StreamsMutex.Lock()
	if buffer != nil {
		stream.Buffer = append(stream.Buffer, buffer...)
	}
	stream.Ended = end
	size = len(stream.Buffer)
	ctx.StreamsMutex.Unlock()

	if OnStreamData == nil {
		panic("did not set OnStreamData")
	}

	// add 1 to size for the done byte prepended in front
	OnStreamData(ctx.Id, storedStreamId, size+1)
}

func StreamEvent(
	ctx *types.CoreCallContext,
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
