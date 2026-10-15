package crypto

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fullstackedorg/fullstacked/types"
	"strings"
	"sync"
	"testing"
)

func newTestContext() *types.Context {
	return &types.Context{Crypto: map[uint32]any{}, CryptoMutex: &sync.Mutex{}, NextCryptoId: 1}
}

// call runs fn through Switch with the arguments serialized the way the
// bridge delivers them
func call(ctx *types.Context, fn CryptoFn, values ...any) (any, error) {
	data := make([]types.DeserializedData, len(values))
	for i, v := range values {
		switch v := v.(type) {
		case nil:
			data[i] = types.DeserializedData{Type: types.UNDEFINED}
		case bool:
			data[i] = types.DeserializedData{Type: types.BOOLEAN, Data: v}
		case string:
			data[i] = types.DeserializedData{Type: types.STRING, Data: v}
		case int:
			data[i] = types.DeserializedData{Type: types.NUMBER, Data: float64(v)}
		case float64:
			data[i] = types.DeserializedData{Type: types.NUMBER, Data: v}
		case []byte:
			// a nil slice is a missing optional argument
			if v == nil {
				data[i] = types.DeserializedData{Type: types.UNDEFINED}
			} else {
				data[i] = types.DeserializedData{Type: types.BUFFER, Data: v}
			}
		default:
			raw, _ := json.Marshal(v)
			data[i] = types.DeserializedData{Type: types.OBJECT, Data: types.DeserializedRawObject{Data: raw}}
		}
	}
	response := types.CoreCallResponse{}
	err := Switch(ctx, types.CoreCallHeader{Module: types.Crypto, Fn: fn}, data, &response)
	return response.Data, err
}

func mustCall(t *testing.T, ctx *types.Context, fn CryptoFn, values ...any) any {
	t.Helper()
	out, err := call(ctx, fn, values...)
	if err != nil {
		t.Fatalf("fn %d: %v", fn, err)
	}
	return out
}

func mustBytes(t *testing.T, ctx *types.Context, fn CryptoFn, values ...any) []byte {
	t.Helper()
	return mustCall(t, ctx, fn, values...).([]byte)
}

// expectError checks the class and code the JS side rebuilds the Node
// error from
func expectError(t *testing.T, err error, classAndCode string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s, got no error", classAndCode)
	}
	if !strings.HasPrefix(err.Error(), classAndCode+"|") {
		t.Fatalf("expected %s, got %s", classAndCode, err.Error())
	}
}

func unhex(s string) []byte {
	b, err := hex.DecodeString(strings.ReplaceAll(s, " ", ""))
	if err != nil {
		panic(err)
	}
	return b
}

func unb64(s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// fill is the generator's buffer pattern: start, start+7, start+14...
func fill(n int, start int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(start + i*7)
	}
	return b
}

func expectHex(t *testing.T, name string, got []byte, want string) {
	t.Helper()
	if hex.EncodeToString(got) != strings.ReplaceAll(want, " ", "") {
		t.Fatalf("%s:\n got %x\nwant %s", name, got, want)
	}
}

func handleOf(t *testing.T, out any) float64 {
	t.Helper()
	switch v := out.(type) {
	case float64:
		return v
	case []byte:
		return float64(binary.BigEndian.Uint32(v))
	}
	t.Fatalf("no handle in %v", out)
	return 0
}

func TestHash(t *testing.T) {
	ctx := newTestContext()
	abc := []byte("abc")
	for algorithm := range digests {
		expectHex(t, algorithm, mustBytes(t, ctx, Hash, algorithm, nil, abc), nodeVectors["hash."+algorithm])
		if digests[algorithm].shake == nil {
			expectHex(t, "hmac "+algorithm, mustBytes(t, ctx, Hash, algorithm, []byte("key"), abc), nodeVectors["hmac."+algorithm])
		}
	}

	// RFC 4231 test cases 1 and 2
	expectHex(t, "hmac rfc4231 1", mustBytes(t, ctx, Hash, "sha256", bytes.Repeat([]byte{0x0b}, 20), []byte("Hi There")),
		"b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7")
	expectHex(t, "hmac rfc4231 2", mustBytes(t, ctx, Hash, "sha512", []byte("Jefe"), []byte("what do ya want for nothing?")),
		"164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737")

	// SHAKE output lengths and Node's errors
	expectHex(t, "shake128/32", mustBytes(t, ctx, Hash, "shake128", nil, abc, 32), nodeVectors["shake128.32"])
	expectHex(t, "shake256/0", mustBytes(t, ctx, Hash, "shake256", nil, abc, 0), "")
	expectHex(t, "sha256/32", mustBytes(t, ctx, Hash, "sha256", nil, abc, 32), nodeVectors["hash.sha256"])
	_, err := call(ctx, Hash, "sha256", nil, abc, 16)
	expectError(t, err, "Error|ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH")
	_, err = call(ctx, Hash, "foo", nil, abc)
	expectError(t, err, "Error|")
	_, err = call(ctx, Hash, "foo", []byte("k"), abc)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_DIGEST")
	_, err = call(ctx, HashCreate, "shake128", []byte("k"))
	expectError(t, err, "Error|")
}

func TestHashHandles(t *testing.T) {
	ctx := newTestContext()
	for algorithm := range digests {
		for _, key := range [][]byte{nil, []byte("key")} {
			if key != nil && digests[algorithm].shake != nil {
				continue
			}
			h := mustCall(t, ctx, HashCreate, algorithm, key)
			mustCall(t, ctx, HashUpdate, h, []byte("a"))
			mustCall(t, ctx, HashUpdate, h, []byte("b"))

			if key == nil {
				// a copy goes on independently
				c := mustCall(t, ctx, HashCopy, h)
				mustCall(t, ctx, HashUpdate, c, []byte("x"))
				mustCall(t, ctx, HashDigest, c)
			}

			mustCall(t, ctx, HashUpdate, h, []byte("c"))
			want := "hash."
			if key != nil {
				want = "hmac."
			}
			expectHex(t, algorithm, mustBytes(t, ctx, HashDigest, h), nodeVectors[want+algorithm])

			// the digest freed the handle
			_, err := call(ctx, HashUpdate, h, []byte("a"))
			expectError(t, err, "Error|ERR_CRYPTO_INVALID_STATE")
		}
	}

	h := mustCall(t, ctx, HashCreate, "shake128", nil, 4)
	mustCall(t, ctx, HashUpdate, h, []byte("abc"))
	c := mustCall(t, ctx, HashCopy, h, 32)
	expectHex(t, "shake copy", mustBytes(t, ctx, HashDigest, c), nodeVectors["shake128.32"])
	expectHex(t, "shake", mustBytes(t, ctx, HashDigest, h), nodeVectors["shake128.32"][:8])

	if len(ctx.Crypto) != 0 {
		t.Fatalf("handles left: %d", len(ctx.Crypto))
	}
}

func TestHandles(t *testing.T) {
	ctx := newTestContext()
	first := mustCall(t, ctx, HashCreate, "sha256").(float64)
	if first != 1 {
		t.Fatalf("first handle %v", first)
	}
	// ids move on, a freed id is not reused right away
	mustCall(t, ctx, Free, first)
	if second := mustCall(t, ctx, HashCreate, "sha256").(float64); second != 2 {
		t.Fatalf("second handle %v", second)
	}
	// freeing twice or an unknown id is fine
	mustCall(t, ctx, Free, first)
	mustCall(t, ctx, Free, 12345)
	mustCall(t, ctx, Free, nil)

	// wrapping skips 0 and the ids in use
	ctx.NextCryptoId = 0xffffffff
	if id := mustCall(t, ctx, HashCreate, "sha256").(float64); id != 0xffffffff {
		t.Fatalf("handle %v", id)
	}
	if id := mustCall(t, ctx, HashCreate, "sha256").(float64); id != 1 {
		t.Fatalf("wrapped handle %v", id)
	}
	if id := mustCall(t, ctx, HashCreate, "sha256").(float64); id != 3 {
		t.Fatalf("handle after the one in use %v", id)
	}

	for len(ctx.Crypto) < maxHandles {
		mustCall(t, ctx, HashCreate, "sha256")
	}
	_, err := call(ctx, HashCreate, "sha256")
	expectError(t, err, "Error|ERR_CRYPTO_OPERATION_FAILED")

	// a handle of another kind is refused
	mustCall(t, ctx, Free, 2)
	cipher := handleOf(t, mustCall(t, ctx, CipherInit, "aes-128-ctr", make([]byte, 16), make([]byte, 16), false))
	_, err = call(ctx, HashUpdate, cipher, []byte("a"))
	expectError(t, err, "Error|ERR_CRYPTO_INVALID_STATE")

	// a context that ended takes no new handle
	ctx.Crypto = nil
	_, err = call(ctx, HashCreate, "sha256")
	expectError(t, err, "Error|ERR_CRYPTO_OPERATION_FAILED")
}
