package router

import (
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/bundle"
	"fullstackedorg/fullstacked/internal/config"
	"fullstackedorg/fullstacked/internal/dgram"
	"fullstackedorg/fullstacked/internal/dns"
	"fullstackedorg/fullstacked/internal/fetch"
	"fullstackedorg/fullstacked/internal/frames"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/internal/git"
	"fullstackedorg/fullstacked/internal/net"
	"fullstackedorg/fullstacked/internal/os"
	"fullstackedorg/fullstacked/internal/packages"
	"fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/internal/plugin"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/internal/stream"
	"fullstackedorg/fullstacked/internal/test"
	"fullstackedorg/fullstacked/internal/tunnel"
	"fullstackedorg/fullstacked/internal/websocket"
	"fullstackedorg/fullstacked/types"
	"path/filepath"
	"strconv"
	"strings"
)

type CoreFn = uint8

const (
	StaticFile CoreFn = 0
	Run        CoreFn = 1
	Cwd        CoreFn = 2
	Chdir      CoreFn = 3
	GetEnv     CoreFn = 4
	Exit       CoreFn = 5
	DeepLink   CoreFn = 6
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
	ctx, header, data, err := parseCall(payload)
	if err != nil {
		return 0, err
	}

	ctx.ResponsesMutex.Lock()
	_, used := ctx.Responses[header.Id]
	ctx.ResponsesMutex.Unlock()

	if used {
		return 0, errors.New("id already in use for another call")
	}

	return store.StoreResponse(ctx, header, processCall(ctx, header, data))
}

// CallWithResponse processes the call and returns its response payload
// directly, the request id is not used so concurrent calls never collide
func CallWithResponse(payload []byte) ([]byte, error) {
	ctx, header, data, err := parseCall(payload)
	if err != nil {
		return nil, err
	}

	return store.BuildResponse(ctx, processCall(ctx, header, data))
}

// Responses from this size go on the frame stream when the call came on a
// message channel: messages carry strings (base64) the page then decodes,
// frames carry bytes.
const ResponseFrameMinSize = 16 << 10

// CallForMessage processes a call received on a message channel. A large
// response is queued as a response frame when a frame reader is attached,
// then framed is true and the message reply carries nothing. Errors come
// back as error responses so a reply is only empty when framed.
func CallForMessage(payload []byte) (response []byte, framed bool) {
	ctx, header, data, err := parseCall(payload)
	if err == nil {
		response, err = store.BuildResponse(ctx, processCall(ctx, header, data))
	}
	if err != nil {
		response, _ = store.BuildResponse(nil, types.CoreCallResponse{
			Type: types.CoreResponseError,
			Data: err.Error(),
		})
		return response, false
	}

	if len(response) >= ResponseFrameMinSize && ctx.Frames.Push(header.Id, frames.FlagResponse, response) {
		return nil, true
	}

	return response, false
}

func parseCall(payload []byte) (*types.Context, types.CoreCallHeader, []types.DeserializedData, error) {
	header := types.CoreCallHeader{}

	if len(payload) < 5 {
		return nil, header, nil, errors.New("payload needs at least ctx, id, module, function, sync/async")
	}

	ctxId := payload[0]
	ctx, ok := store.GetContext(ctxId)

	if !ok {
		return nil, header, nil, errors.New("unkown call context " + strconv.Itoa(int(ctxId)))
	}

	header = types.CoreCallHeader{
		Id:     payload[1],
		Module: payload[2],
		Fn:     payload[3],
		Sync:   payload[4],
	}

	data, err := serialization.DeserializeAll(payload[5:])

	if err != nil {
		return nil, header, nil, errors.New("failed to deserialize payload data")
	}

	return ctx, header, data, nil
}

func processCall(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
) types.CoreCallResponse {
	response := types.CoreCallResponse{}

	coreError := callProcess(ctx, header, data, &response)

	if coreError != nil {
		return types.CoreCallResponse{
			Type: types.CoreResponseError,
			Data: coreError.Error(),
		}
	}

	return response
}

var modules = map[types.CoreModule]types.ModuleSwitch{
	types.Core:      Switch,
	types.Stream:    stream.Switch,
	types.Path:      path.Switch,
	types.Fs:        fs.Switch,
	types.Os:        os.Switch,
	types.Fetch:     fetch.Switch,
	types.Bundle:    bundle.Switch,
	types.Net:       net.Switch,
	types.Tunnel:    tunnel.Switch,
	types.Dns:       dns.Switch,
	types.Git:       git.Switch,
	types.Packages:  packages.Switch,
	types.Dgram:     dgram.Switch,
	types.Test:      test.Switch,
	types.Plugin:    plugin.Switch,
	types.WebSocket: websocket.Switch,
	types.Config:    config.Switch,
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

		safe := false
		if len(data) > 2 && data[2].Type == types.BOOLEAN {
			safe = data[2].Data.(bool)
		}

		id := store.NewContext(root, root, safe)
		response.Data = id

		if len(data) > 1 && data[1].Type == types.OBJECT {
			env := (map[string]string)(nil)
			err := json.Unmarshal(data[1].Data.(types.DeserializedRawObject).Data, &env)

			if err == nil {
				store.SetEnvironmentData(id, env)
			}
		}

		return nil
	case Cwd:
		response.Type = types.CoreResponseData
		response.Data = ctx.Cwd
		return nil
	case Chdir:
		response.Type = types.CoreResponseData
		dir := data[0].Data.(string)
		if dir == "" {
			dir = "/"
		}

		currentCwd := ctx.Cwd
		if currentCwd == "" {
			currentCwd = "/"
		}

		isAbs := filepath.IsAbs(dir) || strings.HasPrefix(dir, "/") || strings.HasPrefix(dir, "\\")
		var targetCwd string
		if isAbs {
			targetCwd = dir
		} else {
			targetCwd = filepath.Join(currentCwd, dir)
		}

		targetCwd = filepath.Clean(targetCwd)
		if !strings.HasPrefix(targetCwd, "/") && !strings.HasPrefix(targetCwd, "\\") {
			targetCwd = "/" + targetCwd
		}
		targetCwd = filepath.ToSlash(targetCwd)

		if targetCwd == "" || targetCwd == "." {
			targetCwd = "/"
		}

		ctx.Cwd = targetCwd
		return nil
	case GetEnv:
		response.Type = types.CoreResponseData
		response.Data = ctx.Env
		return nil
	case Exit:
		response.Type = types.CoreResponseData
		store.ExitContext(ctx.Id)
		return nil
	case DeepLink:
		if len(data) == 0 || data[0].Type != types.STRING {
			return errors.New("deeplink requires a url string")
		}
		response.Type = types.CoreResponseData
		response.Data = plugin.TriggerDeepLink(ctx, data[0].Data.(string))
		return nil
	}

	return errors.New("unknown core function")
}
