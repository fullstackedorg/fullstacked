package plugin

import (
	"fmt"
	"fullstackedorg/fullstacked/types"
	"time"
)

// A deeplink can reach a context before its project registered a deeplink
// plugin (the deeplink that launched the app): it waits for the next deeplink
// plugin to be ready, at most maxPendingDeepLinks per context and for
// pendingDeepLinkTTL, so nothing piles up if no plugin ever registers.
const (
	maxPendingDeepLinks = 8
	pendingDeepLinkTTL  = 60 * time.Second
)

var now = time.Now

// TriggerDeepLink calls the deeplink plugins of ctx with url and returns how
// many were called, or queues url when none is registered yet. The calls run
// in goroutines: platforms call DeepLink synchronously, often from the thread
// that also delivers the plugin stream events to the JS runtime, so waiting
// here would deadlock.
func TriggerDeepLink(ctx *types.Context, url string) int {
	plugins := GetPluginsOfTypes(ctx, types.PluginTypeDeepLink)
	if len(plugins) == 0 {
		queueDeepLink(ctx, url)
		return 0
	}
	for _, p := range plugins {
		go callDeepLink(ctx, p.Id, url)
	}
	return len(plugins)
}

// deliverPendingDeepLinks hands the queued deeplinks to a deeplink plugin that
// just became ready.
func deliverPendingDeepLinks(ctx *types.Context, pluginId uint8) {
	for _, url := range takePendingDeepLinks(ctx) {
		go callDeepLink(ctx, pluginId, url)
	}
}

func callDeepLink(ctx *types.Context, pluginId uint8, url string) {
	_, err := Call(ctx, pluginId, []types.SerializableData{url})
	if err != nil {
		fmt.Println("deeplink plugin error:", err.Error())
	}
}

func queueDeepLink(ctx *types.Context, url string) {
	ctx.PendingDeepLinksMutex.Lock()
	pending := append(unexpiredDeepLinks(ctx.PendingDeepLinks), types.PendingDeepLink{
		Url:        url,
		ReceivedAt: now(),
	})
	if len(pending) > maxPendingDeepLinks {
		pending = pending[len(pending)-maxPendingDeepLinks:]
	}
	ctx.PendingDeepLinks = pending
	ctx.PendingDeepLinksMutex.Unlock()

	// free the memory even if no deeplink plugin ever registers
	time.AfterFunc(pendingDeepLinkTTL, func() {
		prunePendingDeepLinks(ctx)
	})
}

func takePendingDeepLinks(ctx *types.Context) []string {
	ctx.PendingDeepLinksMutex.Lock()
	defer ctx.PendingDeepLinksMutex.Unlock()

	urls := []string{}
	for _, pending := range unexpiredDeepLinks(ctx.PendingDeepLinks) {
		urls = append(urls, pending.Url)
	}
	ctx.PendingDeepLinks = nil
	return urls
}

func prunePendingDeepLinks(ctx *types.Context) {
	ctx.PendingDeepLinksMutex.Lock()
	defer ctx.PendingDeepLinksMutex.Unlock()

	ctx.PendingDeepLinks = unexpiredDeepLinks(ctx.PendingDeepLinks)
	if len(ctx.PendingDeepLinks) == 0 {
		ctx.PendingDeepLinks = nil
	}
}

func unexpiredDeepLinks(pending []types.PendingDeepLink) []types.PendingDeepLink {
	cutoff := now().Add(-pendingDeepLinkTTL)
	kept := []types.PendingDeepLink{}
	for _, p := range pending {
		if p.ReceivedAt.After(cutoff) {
			kept = append(kept, p)
		}
	}
	return kept
}
