package router

import (
	"errors"
	"fullstackedorg/fullstacked/internal/bundle"
	"fullstackedorg/fullstacked/internal/fetch"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/internal/os"
	"fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/internal/stream"
	"fullstackedorg/fullstacked/internal/test"
	"fullstackedorg/fullstacked/types"
)

type CoreFn = uint8

const (
	StaticFile CoreFn = 0
)

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
	ctx, ok := store.Contexts[ctxId]

	if !ok {
		return 0, errors.New("unkown call context")
	}

	id := payload[1]

	ctx.ResponsesMutex.Lock()
	_, used := ctx.Responses[id]
	ctx.ResponsesMutex.Unlock()

	if used {
		return 0, errors.New("id already in use for another call")
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
		size, err = store.StoreResponse(&ctx, header, types.CoreCallResponse{
			Type: types.CoreResponseError,
			Data: coreError.Error(),
		})
	} else {
		size, err = store.StoreResponse(&ctx, header, response)
	}

	if err != nil {
		return 0, err
	}

	return size, nil
}

var modules = map[types.CoreModule]types.ModuleSwitch{
	types.Core:   Switch,
	types.Stream: stream.Switch,
	types.Path:   path.Switch,
	types.Fs:     fs.Switch,
	types.Os:     os.Switch,
	types.Fetch:  fetch.Switch,
	types.Bundle: bundle.Switch,
	types.Test:   test.Switch,
}

func callProcess(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	moduleSwitch, ok := modules[header.Module]

	if !ok {
		return errors.New("unknown module")
	}

	return moduleSwitch(ctx, header, data, response)
}

func Switch(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case StaticFile:
		response.Type = types.CoreResponseData
		response.Data = staticFile(ctx, data[0].Data.(string))
		return nil
	}

	return errors.New("unknown core function")
}
