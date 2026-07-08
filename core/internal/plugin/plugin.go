package plugin

import (
	"errors"
	"fmt"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"sync"
)

type PluginFn = uint8

const (
	StartPluginStream PluginFn = 0
	Register          PluginFn = 1
	Unregister        PluginFn = 2
)

func GetPluginsOfTypes(ctx *types.Context, pluginType types.PluginType) []*types.ContextPlugin {
	if ctx.PluginsMutex == nil {
		ctx.PluginsMutex = &sync.Mutex{}
	}
	ctx.PluginsMutex.Lock()
	defer ctx.PluginsMutex.Unlock()

	var plugins []*types.ContextPlugin
	for _, plugin := range ctx.Plugins {
		if plugin.Type == pluginType {
			plugins = append(plugins, plugin)
		}
	}
	return plugins
}

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case StartPluginStream:
		response.Type = types.CoreResponseStream

		ctx.PluginsMutex = &sync.Mutex{}

		stream := types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				ctx.PluginsMutex.Lock()
				ctx.PluginStreamId = streamId
				ctx.Plugins = make(map[uint8]*types.ContextPlugin)
				ctx.PluginsMutex.Unlock()

				store.StreamEvent(ctx, streamId, "ready", nil, false)
			},
			Close: func(ctx *types.Context, streamId uint8) {
				ctx.PluginsMutex.Lock()
				ctx.PluginStreamId = 0
				ctx.PluginsMutex.Unlock()
			},
			WriteEvent: func(ctx *types.Context, streamId uint8, event string, data []types.DeserializedData) {
				if event != "plugin-response" {
					fmt.Println("Unknown plugin stream event type: ", event)
					return
				}

				pluginId := (uint8)(data[0].Data.(float64))
				pluginRequestId := (uint8)(data[1].Data.(float64))

				ctx.PluginsMutex.Lock()
				plugin, ok := ctx.Plugins[pluginId]
				ctx.PluginsMutex.Unlock()
				if !ok {
					fmt.Println("Plugin not found")
					return
				}

				if plugin.RequestsMutex == nil {
					plugin.RequestsMutex = &sync.Mutex{}
				}
				if plugin.Requests == nil {
					plugin.Requests = make(map[uint8]*types.PluginRequest)
				}

				plugin.RequestsMutex.Lock()
				request, ok := plugin.Requests[pluginRequestId]
				plugin.RequestsMutex.Unlock()
				if !ok {
					fmt.Println("Plugin request not found")
					return
				}

				if data[2].Type == types.STRING {
					errorMessage := data[2].Data.(string)
					request.ResponseError = &errorMessage
				}

				request.Response = data[3:]
				request.Wg.Done()
			},
		}

		response.Stream = &stream
		return nil
	case Register:
		pluginType := types.PluginType(data[0].Data.(string))
		pluginName := data[1].Data.(string)

		var pluginData types.DeserializedRawObject
		if len(data) > 2 {
			pluginData = data[2].Data.(types.DeserializedRawObject)
		}

		pluginId, err := registerPlugin(ctx, pluginType, pluginName, pluginData)
		if err != nil {
			return err
		}

		response.Type = types.CoreResponseData
		response.Data = pluginId

		return nil
	case Unregister:
		pluginId := (uint8)(data[0].Data.(float64))
		unregisterPlugin(ctx, pluginId)

		response.Type = types.CoreResponseData
		response.Data = nil

		return nil

	}

	return errors.New("unknown plugin function")
}

func registerPlugin(ctx *types.Context, pluginType types.PluginType, name string, data types.DeserializedRawObject) (uint8, error) {
	if ctx.PluginStreamId == 0 || ctx.Plugins == nil || ctx.PluginsMutex == nil {
		return 0, errors.New("plugin stream not started")
	}

	ctx.PluginsMutex.Lock()
	defer ctx.PluginsMutex.Unlock()

	id := (uint8)(1)

	for {
		if ctx.Plugins[id] == nil {
			break
		}

		id++
		if id == 0 {
			id++
		}
	}

	ctx.Plugins[id] = &types.ContextPlugin{
		Id:            id,
		Type:          pluginType,
		Name:          name,
		Data:          data,
		Requests:      make(map[uint8]*types.PluginRequest),
		RequestsMutex: &sync.Mutex{},
	}

	return id, nil
}

func unregisterPlugin(ctx *types.Context, pluginId uint8) error {
	if ctx.PluginsMutex == nil {
		ctx.PluginsMutex = &sync.Mutex{}
	}
	ctx.PluginsMutex.Lock()
	defer ctx.PluginsMutex.Unlock()

	delete(ctx.Plugins, pluginId)
	return nil
}

func Call(ctx *types.Context, pluginId uint8, data []types.SerializableData) ([]types.DeserializedData, error) {
	if ctx.PluginStreamId == 0 {
		panic("calling plugin without plugin stream started")
	}

	ctx.PluginsMutex.Lock()
	plugin, ok := ctx.Plugins[pluginId]
	ctx.PluginsMutex.Unlock()
	if !ok {
		return nil, errors.New("plugin not found")
	}

	if plugin.RequestsMutex == nil {
		plugin.RequestsMutex = &sync.Mutex{}
	}
	if plugin.Requests == nil {
		plugin.Requests = make(map[uint8]*types.PluginRequest)
	}

	pluginRequestId := (uint8)(0)
	wg := sync.WaitGroup{}

	plugin.RequestsMutex.Lock()
	for {
		_, ok := plugin.Requests[pluginRequestId]
		if !ok {
			break
		}
		pluginRequestId++
	}

	pluginCallPayload := []types.SerializableData{pluginId, pluginRequestId}

	plugin.Requests[pluginRequestId] = &types.PluginRequest{
		Wg: &wg,
	}
	plugin.RequestsMutex.Unlock()

	pluginCallPayload = append(pluginCallPayload, data...)

	wg.Add(1)

	store.StreamEvent(ctx, ctx.PluginStreamId, "plugin-call", pluginCallPayload, false)

	wg.Wait()

	plugin.RequestsMutex.Lock()
	completedRequest, ok := plugin.Requests[pluginRequestId]
	plugin.RequestsMutex.Unlock()
	if !ok {
		return nil, errors.New("plugin request not found")
	}

	response := completedRequest.Response

	var err error
	if responseError := completedRequest.ResponseError; responseError != nil {
		err = errors.New(*responseError)
	}

	plugin.RequestsMutex.Lock()
	delete(plugin.Requests, pluginRequestId)
	plugin.RequestsMutex.Unlock()

	return response, err
}
