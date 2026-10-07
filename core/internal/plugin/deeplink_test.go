package plugin

import (
	"fmt"
	"fullstackedorg/fullstacked/types"
	"reflect"
	"sync"
	"testing"
	"time"
)

func newDeepLinkContext() *types.Context {
	return &types.Context{PendingDeepLinksMutex: &sync.Mutex{}}
}

func useClock(t *testing.T, start time.Time) func(time.Duration) {
	current := start
	now = func() time.Time { return current }
	t.Cleanup(func() { now = time.Now })
	return func(d time.Duration) { current = current.Add(d) }
}

func TestDeepLinkWithoutPluginIsQueued(t *testing.T) {
	useClock(t, time.Unix(1000, 0))
	ctx := newDeepLinkContext()

	if called := TriggerDeepLink(ctx, "fullstacked:///command/a"); called != 0 {
		t.Fatalf("called %d plugins, want 0", called)
	}
	TriggerDeepLink(ctx, "fullstacked:///command/b")

	got := takePendingDeepLinks(ctx)
	want := []string{"fullstacked:///command/a", "fullstacked:///command/b"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("pending = %v, want %v", got, want)
	}
	if again := takePendingDeepLinks(ctx); len(again) != 0 {
		t.Fatalf("pending delivered twice: %v", again)
	}
}

func TestPendingDeepLinksKeepTheMostRecent(t *testing.T) {
	useClock(t, time.Unix(1000, 0))
	ctx := newDeepLinkContext()

	for i := 0; i < maxPendingDeepLinks+3; i++ {
		queueDeepLink(ctx, fmt.Sprintf("link-%d", i))
	}

	got := takePendingDeepLinks(ctx)
	if len(got) != maxPendingDeepLinks || got[0] != "link-3" {
		t.Fatalf("pending = %v, want the last %d links", got, maxPendingDeepLinks)
	}
}

func TestPendingDeepLinksExpire(t *testing.T) {
	advance := useClock(t, time.Unix(1000, 0))
	ctx := newDeepLinkContext()

	queueDeepLink(ctx, "old")
	advance(pendingDeepLinkTTL - time.Second)
	queueDeepLink(ctx, "recent")
	advance(2 * time.Second)

	if got := takePendingDeepLinks(ctx); !reflect.DeepEqual(got, []string{"recent"}) {
		t.Fatalf("pending = %v, want [recent]", got)
	}
}

func TestPruneFreesExpiredDeepLinks(t *testing.T) {
	advance := useClock(t, time.Unix(1000, 0))
	ctx := newDeepLinkContext()

	queueDeepLink(ctx, "never delivered")
	advance(pendingDeepLinkTTL + time.Second)
	prunePendingDeepLinks(ctx)

	if ctx.PendingDeepLinks != nil {
		t.Fatalf("pending = %v, want nil", ctx.PendingDeepLinks)
	}
}
