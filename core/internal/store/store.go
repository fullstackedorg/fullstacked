package store

import (
	"errors"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/types"
	"sync"
)

var Callback = (func(uint8, uint8, int))(nil)

var ctxCount = 0
var Contexts = map[uint8]types.CoreCallContext{}
var ctxMutex = sync.Mutex{}

func NewContext(directory string) uint8 {
	ctxMutex.Lock()
	id := uint8(ctxCount % 256)
	Contexts[id] = types.CoreCallContext{
		Id:             id,
		BaseDirectory:  directory,
		Responses:      map[uint8]*types.StoredResponse{},
		ResponsesMutex: &sync.Mutex{},
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
	buffer := []byte{response.Type}

	if response.Data != nil {
		data, err := serialization.Serialize(response.Data)
		if err != nil {
			return 0, err
		}
		buffer, err = serialization.MergeBuffers(buffer, data)
		if err != nil {
			return 0, err
		}
	}

	ctx.ResponsesMutex.Lock()
	ctx.Responses[header.Id] = &types.StoredResponse{
		Type:   response.Type,
		Buffer: buffer,
		Ended:  response.Type == types.CoreResponseData || response.Type == types.CoreResponseError,
		Stream: response.Stream,
	}
	ctx.ResponsesMutex.Unlock()

	return len(buffer), nil
}

func GetCoreResponse(ctxId uint8, id uint8, openStream bool) ([]byte, error) {
	ctx, ok := Contexts[ctxId]

	if !ok {
		return nil, errors.New("unkown call context")
	}

	ctx.ResponsesMutex.Lock()
	response, ok := ctx.Responses[id]
	ctx.ResponsesMutex.Unlock()

	if !ok {
		return nil, errors.New("cannot find response for id")
	}

	didOpenStream := false
	if !response.Opened && openStream {
		response.Stream()
		didOpenStream = true
	}

	ctx.ResponsesMutex.Lock()
	if didOpenStream {
		response.Opened = true
	}
	buffer := response.Buffer
	if response.Ended {
		defer delete(ctx.Responses, id)
	} else {
		response.Buffer = []byte{}
	}
	ctx.ResponsesMutex.Unlock()

	if response.Opened {
		doneByte := []byte{0}
		if response.Ended {
			doneByte = []byte{1}
		}
		buffer, _ = serialization.MergeBuffers(doneByte, buffer)
	}

	return buffer, nil
}

func StreamChunk(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	buffer []byte,
	end bool,
) {
	ctx.ResponsesMutex.Lock()
	response, ok := ctx.Responses[header.Id]
	ctx.ResponsesMutex.Unlock()

	if !ok {
		panic("no response for stream chunk")
	}

	size := 0
	ctx.ResponsesMutex.Lock()
	response.Buffer = append(response.Buffer, buffer...)
	response.Ended = end
	size = len(response.Buffer)
	ctx.ResponsesMutex.Unlock()

	if !response.Opened {
		return
	}

	if Callback == nil {
		panic("no callback")
	}

	// add 1 to size for the done byte prepended in front
	Callback(ctx.Id, header.Id, size+1)
}
