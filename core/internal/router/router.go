package router

import (
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/bundle"
	"fullstackedorg/fullstacked/internal/dgram"
	"fullstackedorg/fullstacked/internal/dns"
	"fullstackedorg/fullstacked/internal/fetch"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/internal/git"
	"fullstackedorg/fullstacked/internal/net"
	"fullstackedorg/fullstacked/internal/os"
	"fullstackedorg/fullstacked/internal/packages"
	"fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/internal/sentry"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/internal/stream"
	"fullstackedorg/fullstacked/internal/test"
	"fullstackedorg/fullstacked/internal/tunnel"
	"fullstackedorg/fullstacked/types"
	"path/filepath"
	"strconv"
)

type CoreFn = uint8

const (
	StaticFile CoreFn = 0
	Run        CoreFn = 1
	GetEnv     CoreFn = 2
)

/*
0: 1 byte ctx
1: 1 byte id
2: 1 byte module
3: 1 byte fn
4: 1 byte (0 = async, 1 sync)
5: n bytes data
*/

func Call(payload []byte) (int, error) {
	if len(payload) < 5 {
		return 0, errors.New("payload needs at least ctx, id, module, function, sync/async")
	}

	ctxId := payload[0]
	ctx, ok := store.Contexts[ctxId]

	if !ok {
		return 0, errors.New("unkown call context " + strconv.Itoa(int(ctxId)))
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
		Sync:   payload[4],
	}

	data, err := serialization.DeserializeAll(payload[5:])

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
	types.Core:     Switch,
	types.Stream:   stream.Switch,
	types.Path:     path.Switch,
	types.Fs:       fs.Switch,
	types.Os:       os.Switch,
	types.Fetch:    fetch.Switch,
	types.Bundle:   bundle.Switch,
	types.Net:      net.Switch,
	types.Tunnel:   tunnel.Switch,
	types.Dns:      dns.Switch,
	types.Git:      git.Switch,
	types.Packages: packages.Switch,
	types.Sentry:   sentry.Switch,
	types.Dgram:    dgram.Switch,
	types.Test:     test.Switch,
}

func callProcess(
	ctx *types.Context,
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

var OnNewContext = func(ctx uint8) {}

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case StaticFile:
		response.Type = types.CoreResponseData
		response.Data = staticFile(ctx, data[0].Data.(string))
		return nil
	case Run:
		response.Type = types.CoreResponseData
		root := filepath.Join(ctx.Directories.Root, data[0].Data.(string))

		id := store.NewContext(root, root)

		if store.OnStreamData == nil {
			return errors.New("onStreamData not set")
		}

		if len(data) > 1 && data[1].Type == types.OBJECT {
			env := (map[string]string)(nil)
			err := json.Unmarshal(data[1].Data.(types.DeserializedRawObject).Data, &env)

			if err == nil {
				store.SetEnvironmentData(id, env)
			}
		}

		store.OnStreamData(id, 0, 0)
		return nil
	case GetEnv:
		response.Type = types.CoreResponseData
		response.Data = ctx.Env
		return nil
	}

	return errors.New("unknown core function")
}
