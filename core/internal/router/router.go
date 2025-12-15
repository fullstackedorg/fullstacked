package router

import (
	"errors"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/internal/test"
	"fullstackedorg/fullstacked/types"
	"sync"
)

var ctxCount = 0
var contexts = map[uint8]types.CoreCallContext{}

func NewContext(directory string) uint8 {
	id := uint8(ctxCount % 256)
	contexts[id] = types.CoreCallContext{
		BaseDirectory:  directory,
		Responses:      map[uint8][]byte{},
		ResponsesMutex: &sync.Mutex{},
	}
	ctxCount++

	return id
}

var noResponsePayload, _ = serialization.Serialize("no response")

/*
1 byte ctx
1 byte id
1 byte module
1 byte fn
n bytes data
*/

func Call(payload []byte) (int, error) {
	if len(payload) < 4 {
		return 0, errors.New("payload needs at least ctx, id, module, function")
	}

	ctxId := payload[0]
	ctx, ok := contexts[ctxId]

	if !ok {
		return 0, errors.New("unkown call context")
	}

	header := types.CoreCallHeader{
		Id:     payload[1],
		Module: payload[2],
		Fn:     payload[3],
	}

	data, err := serialization.DeserializeAll(payload[4:])

	if err != nil {
		return 0, errors.New("failed to deserialize payload data")
	}

	response := types.CoreCallResponse{}

	coreError := callProcess(&ctx, header, data, &response)

	size := 0
	if coreError != nil {
		size, err = stashResponse(&ctx, header, types.CoreCallResponse{
			Type: types.CoreResponseError,
			Data: coreError.Error(),
		})
	} else {
		size, err = stashResponse(&ctx, header, response)
	}

	if err != nil {
		return 0, err
	}

	return size, nil
}

func GetCoreResponse(ctxId uint8, id uint8) ([]byte, error) {
	ctx, ok := contexts[ctxId]

	if !ok {
		return nil, errors.New("unkown call context")
	}

	ctx.ResponsesMutex.Lock()
	response, ok := ctx.Responses[id]
	ctx.ResponsesMutex.Unlock()

	if !ok {
		return nil, errors.New("cannot find response for id")
	}

	defer delete(ctx.Responses, id)

	return response, nil
}

func callProcess(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Module {
	case types.Path:
		return path.Switch(ctx, header.Fn, data, response)
	case types.Fs:
		return fs.Switch(ctx, header.Fn, data, response)
	case types.Test:
		return test.Switch(ctx, header.Fn, data, response)
	}

	return errors.New("unknown module")
}

func stashResponse(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	response types.CoreCallResponse) (int, error) {
	buffer := []byte{response.Type}

	if response.Data != nil {
		data, err := serialization.Serialize(response.Data)
		if err != nil {
			return 0, err
		}
		buffer, err = serialization.MergeBuffers([][]byte{buffer, data})
		if err != nil {
			return 0, err
		}
	}

	ctx.ResponsesMutex.Lock()
	ctx.Responses[header.Id] = buffer
	ctx.ResponsesMutex.Unlock()

	return len(buffer), nil
}
