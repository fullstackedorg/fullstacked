package plugin

import (
	"fullstackedorg/fullstacked/types"
	"sync"
	"testing"
	"time"
)

type sentCall struct {
	streamId  uint32
	pluginId  uint8
	requestId uint8
}

// records the plugin calls instead of streaming them
func captureCalls(t *testing.T) chan sentCall {
	calls := make(chan sentCall, 16)
	original := streamEvent
	t.Cleanup(func() { streamEvent = original })
	streamEvent = func(ctx *types.Context, streamId uint32, name string, data []types.SerializableData, end bool) {
		calls <- sentCall{streamId, data[0].(uint8), data[1].(uint8)}
	}
	return calls
}

func newPluginContext() *types.Context {
	return &types.Context{
		PluginsMutex:          &sync.Mutex{},
		PendingDeepLinksMutex: &sync.Mutex{},
	}
}

func mustRegister(t *testing.T, ctx *types.Context, streamId uint32) uint8 {
	t.Helper()
	id, err := registerPlugin(ctx, types.PluginTypeBuild, "p", types.DeserializedRawObject{}, streamId)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

type callResult struct {
	response []types.DeserializedData
	err      error
}

func callAsync(ctx *types.Context, id uint8) chan callResult {
	done := make(chan callResult, 1)
	go func() {
		response, err := Call(ctx, id, []types.SerializableData{"x"})
		done <- callResult{response, err}
	}()
	return done
}

func waitResult(t *testing.T, done chan callResult) callResult {
	t.Helper()
	select {
	case r := <-done:
		return r
	case <-time.After(2 * time.Second):
		t.Fatal("the call never returned")
	}
	return callResult{}
}

func answer(ctx *types.Context, call sentCall, value string) {
	respond(ctx, []types.DeserializedData{
		{Data: float64(call.pluginId), Type: types.NUMBER},
		{Data: float64(call.requestId), Type: types.NUMBER},
		{Data: nil, Type: types.UNDEFINED},
		{Data: value, Type: types.STRING},
	})
}

func TestWorkerStreamKeepsThePagePlugins(t *testing.T) {
	calls := captureCalls(t)
	ctx := newPluginContext()

	openPluginStream(ctx, 1, false) // the page
	page := mustRegister(t, ctx, 1)
	openPluginStream(ctx, 2, true) // a worker
	worker := mustRegister(t, ctx, 2)

	if len(ctx.Plugins) != 2 {
		t.Fatalf("%d plugins, want the page's and the worker's", len(ctx.Plugins))
	}

	// each call goes to the stream of its plugin
	for _, c := range []struct {
		id     uint8
		stream uint32
	}{{page, 1}, {worker, 2}} {
		done := callAsync(ctx, c.id)
		sent := <-calls
		if sent.streamId != c.stream {
			t.Fatalf("plugin %d called on stream %d, want %d", c.id, sent.streamId, c.stream)
		}
		answer(ctx, sent, "ok")
		if r := waitResult(t, done); r.err != nil || r.response[0].Data != "ok" {
			t.Fatalf("call = %v, %v", r.response, r.err)
		}
	}
}

func TestClosingAStreamDropsItsPluginsAndFailsTheirCalls(t *testing.T) {
	calls := captureCalls(t)
	ctx := newPluginContext()

	openPluginStream(ctx, 1, false)
	page := mustRegister(t, ctx, 1)
	openPluginStream(ctx, 2, true)
	worker := mustRegister(t, ctx, 2)

	done := callAsync(ctx, worker)
	sent := <-calls

	closePluginStream(ctx, 2) // the worker ended mid-call

	if r := waitResult(t, done); r.err == nil || r.err.Error() != errPluginGone {
		t.Fatalf("err = %v, want %q", r.err, errPluginGone)
	}
	if _, ok := ctx.Plugins[worker]; ok {
		t.Fatal("the worker's plugin is still registered")
	}
	if _, ok := ctx.Plugins[page]; !ok {
		t.Fatal("the page's plugin went away with the worker")
	}
	// a late answer is ignored
	answer(ctx, sent, "late")

	if _, err := Call(ctx, worker, nil); err == nil {
		t.Fatal("calling a dropped plugin succeeded")
	}
	if _, err := registerPlugin(ctx, types.PluginTypeBuild, "p", types.DeserializedRawObject{}, 2); err == nil {
		t.Fatal("registered on a closed stream")
	}
}

func TestPageStreamReplacesEveryPlugin(t *testing.T) {
	calls := captureCalls(t)
	ctx := newPluginContext()

	openPluginStream(ctx, 1, false)
	mustRegister(t, ctx, 1)
	openPluginStream(ctx, 2, true)
	worker := mustRegister(t, ctx, 2)
	done := callAsync(ctx, worker)
	<-calls

	// the page reloaded: its old streams never closed
	openPluginStream(ctx, 3, false)

	if len(ctx.Plugins) != 0 {
		t.Fatalf("%d plugins left after the reload", len(ctx.Plugins))
	}
	if r := waitResult(t, done); r.err == nil {
		t.Fatal("the call of the old worker still waits")
	}
	if _, err := registerPlugin(ctx, types.PluginTypeBuild, "p", types.DeserializedRawObject{}, 2); err == nil {
		t.Fatal("registered on a stream of the old page")
	}
	mustRegister(t, ctx, 3)
}

func TestRegisterWithoutStreamUsesTheLastOne(t *testing.T) {
	ctx := newPluginContext()

	if _, err := registerPlugin(ctx, types.PluginTypeBuild, "p", types.DeserializedRawObject{}, 0); err == nil {
		t.Fatal("registered before any stream")
	}

	openPluginStream(ctx, 1, false)
	id := mustRegister(t, ctx, 0)
	if got := ctx.Plugins[id].StreamId; got != 1 {
		t.Fatalf("stream %d, want 1", got)
	}
}

func TestUnregisterFailsWaitingCalls(t *testing.T) {
	calls := captureCalls(t)
	ctx := newPluginContext()

	openPluginStream(ctx, 1, false)
	id := mustRegister(t, ctx, 1)
	done := callAsync(ctx, id)
	<-calls

	unregisterPlugin(ctx, id)

	if r := waitResult(t, done); r.err == nil {
		t.Fatal("the call still waits for an unregistered plugin")
	}
}
