package crypto

import (
	"fullstackedorg/fullstacked/types"
	"math"
)

// A page that drops hashes or ciphers without finishing them (and without
// its FinalizationRegistry catching up) fails new ones instead of growing
// the context without bound
const maxHandles = 4096

// newHandle keeps v in the context. Ids start at 1, are never 0 and move
// forward until they wrap, so a stale id from the page does not hit a
// newer object right away.
func newHandle(ctx *types.Context, v any) (uint32, error) {
	ctx.CryptoMutex.Lock()
	defer ctx.CryptoMutex.Unlock()

	if ctx.Crypto == nil {
		return 0, errContextEnded
	}
	if len(ctx.Crypto) >= maxHandles {
		return 0, errTooManyHandles
	}

	id := ctx.NextCryptoId
	for {
		if id == 0 {
			id = 1
		}
		if _, used := ctx.Crypto[id]; !used {
			break
		}
		id++
	}

	ctx.Crypto[id] = v
	ctx.NextCryptoId = id + 1
	return id, nil
}

func handleId(a args, i int) (uint32, bool) {
	n := a.num(i, 0)
	if n < 1 || n > math.MaxUint32 || n != math.Trunc(n) {
		return 0, false
	}
	return uint32(n), true
}

// getHandle returns the object of the handle in argument i, take removes it
// from the context as well
func getHandle[T any](ctx *types.Context, a args, i int, take bool) (T, error) {
	var zero T

	id, ok := handleId(a, i)
	if !ok {
		return zero, errInvalidHandle
	}

	ctx.CryptoMutex.Lock()
	defer ctx.CryptoMutex.Unlock()

	v, ok := ctx.Crypto[id]
	if !ok {
		return zero, errInvalidHandle
	}
	t, ok := v.(T)
	if !ok {
		return zero, errInvalidHandle
	}
	if take {
		delete(ctx.Crypto, id)
	}
	return t, nil
}

// freeHandle drops any kind of handle, an unknown one is not an error: the
// page's FinalizationRegistry may run after the finishing call
func freeHandle(ctx *types.Context, a args) (any, error) {
	id, ok := handleId(a, 0)
	if !ok {
		return nil, nil
	}

	ctx.CryptoMutex.Lock()
	if ctx.Crypto != nil {
		delete(ctx.Crypto, id)
	}
	ctx.CryptoMutex.Unlock()
	return nil, nil
}

func handleBytes(id uint32) []byte {
	return []byte{byte(id >> 24), byte(id >> 16), byte(id >> 8), byte(id)}
}
