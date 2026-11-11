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
	// Ready: the JS runtime can receive calls for the registered plugin
	Ready PluginFn = 3
)

// sends a plugin call on its stream (store.StreamEvent, replaced in tests)
var streamEvent = store.StreamEvent

// the error of a call whose plugin went away before it answered
const errPluginGone = "plugin stream closed before the plugin answered"

// Every runtime of a context (the page, and each worker that registers
// plugins) opens its own plugin stream. A plugin belongs to the stream it
// registered with: its calls are sent there, and it is dropped when that
// stream closes, failing the calls still waiting for it.
//
// The page's stream replaces every plugin of the context when it opens: a
// reloaded page (and the workers it had) never closes its streams, its
// plugins would stay registered and their calls would wait forever. A worker's
// stream keeps the others.

func ensurePlugins(ctx *types.Context) {
	if ctx.PluginsMutex == nil {
		ctx.PluginsMutex = &sync.Mutex{}
	}
}

func GetPluginsOfTypes(ctx *types.Context, pluginType types.PluginType) []*types.ContextPlugin {
	ensurePlugins(ctx)
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

// openPluginStream records a new plugin stream; unless keepOthers (a
// worker), it replaces the plugins and the streams the context had
func openPluginStream(ctx *types.Context, streamId uint32, keepOthers bool) {
	ensurePlugins(ctx)
	ctx.PluginsMutex.Lock()
	var dropped []*types.ContextPlugin
	if !keepOthers || ctx.Plugins == nil || ctx.PluginStreams == nil {
		for _, p := range ctx.Plugins {
			dropped = append(dropped, p)
		}
		ctx.Plugins = make(map[uint8]*types.ContextPlugin)
		ctx.PluginStreams = make(map[uint32]bool)
	}
	ctx.PluginStreams[streamId] = true
	ctx.PluginStreamId = streamId
	ctx.PluginsMutex.Unlock()

	failRequests(dropped)
}

// closePluginStream drops the plugins of a stream that closed
func closePluginStream(ctx *types.Context, streamId uint32) {
	ensurePlugins(ctx)
	ctx.PluginsMutex.Lock()
	var dropped []*types.ContextPlugin
	for id, p := range ctx.Plugins {
		if p.StreamId == streamId {
			dropped = append(dropped, p)
			delete(ctx.Plugins, id)
		}
	}
	delete(ctx.PluginStreams, streamId)
	if ctx.PluginStreamId == streamId {
		ctx.PluginStreamId = 0
	}
	ctx.PluginsMutex.Unlock()

	failRequests(dropped)
}

// failRequests ends the calls still waiting for plugins that went away
func failRequests(plugins []*types.ContextPlugin) {
	for _, p := range plugins {
		if p.RequestsMutex == nil {
			continue
		}
		var waiting []*types.PluginRequest
		p.RequestsMutex.Lock()
		for _, request := range p.Requests {
			if !request.Done {
				request.Done = true
				waiting = append(waiting, request)
			}
		}
		p.RequestsMutex.Unlock()

		for _, request := range waiting {
			message := errPluginGone
			request.ResponseError = &message
			request.Wg.Done()
		}
	}
}

// respond delivers a plugin's answer to the call waiting for it
func respond(ctx *types.Context, data []types.DeserializedData) {
	pluginId := (uint8)(data[0].Data.(float64))
	pluginRequestId := (uint8)(data[1].Data.(float64))

	ensurePlugins(ctx)
	ctx.PluginsMutex.Lock()
	plugin, ok := ctx.Plugins[pluginId]
	ctx.PluginsMutex.Unlock()
	if !ok || plugin.RequestsMutex == nil {
		fmt.Println("Plugin not found")
		return
	}

	plugin.RequestsMutex.Lock()
	request, ok := plugin.Requests[pluginRequestId]
	if ok && request.Done {
		ok = false
	}
	if ok {
		request.Done = true
	}
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

		// a worker keeps the plugins of the page and of the other workers
		keepOthers := len(data) > 0 && data[0].Type == types.BOOLEAN && data[0].Data.(bool)

		stream := types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint32) {
				openPluginStream(ctx, streamId, keepOthers)
				store.StreamEvent(ctx, streamId, "ready", nil, false)
			},
			Close: func(ctx *types.Context, streamId uint32) {
				closePluginStream(ctx, streamId)
			},
			WriteEvent: func(ctx *types.Context, streamId uint32, event string, data []types.DeserializedData) {
				if event != "plugin-response" {
					fmt.Println("Unknown plugin stream event type: ", event)
					return
				}
				respond(ctx, data)
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

		// the stream of the runtime that registers; bundles from before
		// worker plugins don't say it: the last stream opened
		streamId := uint32(0)
		if len(data) > 3 && data[3].Type == types.NUMBER {
			streamId = uint32(data[3].Data.(float64))
		}

		pluginId, err := registerPlugin(ctx, pluginType, pluginName, pluginData, streamId)
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
	case Ready:
		pluginId := (uint8)(data[0].Data.(float64))

		ensurePlugins(ctx)
		ctx.PluginsMutex.Lock()
		plugin, ok := ctx.Plugins[pluginId]
		ctx.PluginsMutex.Unlock()
		if !ok {
			return errors.New("plugin not found")
		}

		if plugin.Type == types.PluginTypeDeepLink {
			deliverPendingDeepLinks(ctx, pluginId)
		}

		response.Type = types.CoreResponseData
		response.Data = nil

		return nil

	}

	return errors.New("unknown plugin function")
}

func registerPlugin(ctx *types.Context, pluginType types.PluginType, name string, data types.DeserializedRawObject, streamId uint32) (uint8, error) {
	ensurePlugins(ctx)
	ctx.PluginsMutex.Lock()
	defer ctx.PluginsMutex.Unlock()

	if streamId == 0 {
		streamId = ctx.PluginStreamId
	}
	if streamId == 0 || ctx.Plugins == nil || !ctx.PluginStreams[streamId] {
		return 0, errors.New("plugin stream not started")
	}

	id := (uint8)(1)
	for ctx.Plugins[id] != nil {
		id++
		if id == 0 {
			return 0, errors.New("too many plugins")
		}
	}

	ctx.Plugins[id] = &types.ContextPlugin{
		Id:            id,
		Type:          pluginType,
		Name:          name,
		Data:          data,
		StreamId:      streamId,
		Requests:      make(map[uint8]*types.PluginRequest),
		RequestsMutex: &sync.Mutex{},
	}

	return id, nil
}

func unregisterPlugin(ctx *types.Context, pluginId uint8) error {
	ensurePlugins(ctx)
	ctx.PluginsMutex.Lock()
	plugin, ok := ctx.Plugins[pluginId]
	delete(ctx.Plugins, pluginId)
	ctx.PluginsMutex.Unlock()

	if ok {
		failRequests([]*types.ContextPlugin{plugin})
	}
	return nil
}

func Call(ctx *types.Context, pluginId uint8, data []types.SerializableData) ([]types.DeserializedData, error) {
	ensurePlugins(ctx)
	ctx.PluginsMutex.Lock()
	plugin, ok := ctx.Plugins[pluginId]
	ctx.PluginsMutex.Unlock()
	if !ok {
		return nil, errors.New("plugin not found")
	}

	plugin.RequestsMutex.Lock()
	pluginRequestId := (uint8)(0)
	for {
		if _, taken := plugin.Requests[pluginRequestId]; !taken {
			break
		}
		pluginRequestId++
		if pluginRequestId == 0 {
			plugin.RequestsMutex.Unlock()
			return nil, errors.New("too many calls waiting for plugin " + plugin.Name)
		}
	}

	wg := sync.WaitGroup{}
	wg.Add(1)
	request := &types.PluginRequest{Wg: &wg}
	plugin.Requests[pluginRequestId] = request
	plugin.RequestsMutex.Unlock()

	// the plugin may have gone away between the lookup and now: its stream
	// closed and failed the requests it had, not this one
	ctx.PluginsMutex.Lock()
	_, stillThere := ctx.Plugins[pluginId]
	ctx.PluginsMutex.Unlock()
	if !stillThere {
		failRequests([]*types.ContextPlugin{plugin})
	} else {
		pluginCallPayload := append([]types.SerializableData{pluginId, pluginRequestId}, data...)
		streamEvent(ctx, plugin.StreamId, "plugin-call", pluginCallPayload, false)
	}

	wg.Wait()

	plugin.RequestsMutex.Lock()
	delete(plugin.Requests, pluginRequestId)
	plugin.RequestsMutex.Unlock()

	if request.ResponseError != nil {
		return request.Response, errors.New(*request.ResponseError)
	}
	return request.Response, nil
}
