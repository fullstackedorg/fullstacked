package zlib

import (
	"bytes"
	stdflate "compress/flate"
	"compress/gzip"
	stdzlib "compress/zlib"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"fullstackedorg/fullstacked/types"
	"hash/crc32"
	"io"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/andybalholm/brotli"
)

func newTestContext() *types.Context {
	return &types.Context{Zlib: map[uint32]any{}, ZlibMutex: &sync.Mutex{}, NextZlibId: 1}
}

// call runs fn through Switch with the arguments serialized the way the
// bridge delivers them
func call(ctx *types.Context, fn ZlibFn, values ...any) (any, error) {
	data := make([]types.DeserializedData, len(values))
	for i, v := range values {
		switch v := v.(type) {
		case nil:
			data[i] = types.DeserializedData{Type: types.UNDEFINED}
		case string:
			data[i] = types.DeserializedData{Type: types.STRING, Data: v}
		case int:
			data[i] = types.DeserializedData{Type: types.NUMBER, Data: float64(v)}
		case float64:
			data[i] = types.DeserializedData{Type: types.NUMBER, Data: v}
		case []byte:
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
	err := Switch(ctx, types.CoreCallHeader{Module: types.Zlib, Fn: fn}, data, &response)
	return response.Data, err
}

// must(t)(call(...)) is the output of a call that must succeed
func must(t *testing.T) func(any, error) []byte {
	return func(out any, err error) []byte {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		b, _ := out.([]byte)
		return b
	}
}

func vector(t *testing.T, name string) []byte {
	t.Helper()
	b, err := hex.DecodeString(nodeVectors[name])
	if err != nil || nodeVectors[name] == "" {
		t.Fatalf("vector %s", name)
	}
	return b
}

// errCode is the code part of a nodeError, "" for anything else
func errCode(err error) string {
	if e, ok := err.(*nodeError); ok {
		return e.code
	}
	return ""
}

var sample = []byte(strings.Repeat("The quick brown fox jumps over the lazy dog. ", 400) + "€😀")

var compressFormats = []string{"deflate", "deflateRaw", "gzip", "brotli"}

func TestRoundTrips(t *testing.T) {
	ctx := newTestContext()
	random := make([]byte, 5000)
	for i := range random {
		random[i] = byte(i*7919 + 13)
	}
	inputs := map[string][]byte{"text": sample, "random": random, "empty": {}}
	for _, name := range compressFormats {
		for _, level := range []int{-1, 0, 1, 2, 5, 6, 7, 9} {
			for _, strategy := range []int{0, 1, 2, 3, 4} {
				for _, windowBits := range []int{9, 12, 15} {
					opts := map[string]int{"level": level, "strategy": strategy, "windowBits": windowBits, "quality": level + 2}
					for inputName, input := range inputs {
						compressed := must(t)(call(ctx, Compress, name, input, opts))
						back := must(t)(call(ctx, Decompress, name, compressed, map[string]int{}))
						if !bytes.Equal(back, input) {
							t.Fatalf("%s %v %s: round trip differs", name, opts, inputName)
						}
					}
				}
			}
		}
	}
}

// what the core writes, read by Go's own readers: the headers and trailers
// are written here, not by compress/zlib and compress/gzip
func TestStandardReaders(t *testing.T) {
	ctx := newTestContext()
	read := map[string]func([]byte) (io.Reader, error){
		"deflate":    func(b []byte) (io.Reader, error) { return stdzlib.NewReader(bytes.NewReader(b)) },
		"deflateRaw": func(b []byte) (io.Reader, error) { return stdflate.NewReader(bytes.NewReader(b)), nil },
		"gzip":       func(b []byte) (io.Reader, error) { return gzip.NewReader(bytes.NewReader(b)) },
		"brotli":     func(b []byte) (io.Reader, error) { return brotli.NewReader(bytes.NewReader(b)), nil },
	}
	for name, reader := range read {
		for _, level := range []int{-1, 0, 1, 9} {
			compressed := must(t)(call(ctx, Compress, name, sample, map[string]int{"level": level}))
			r, err := reader(compressed)
			if err != nil {
				t.Fatal(name, err)
			}
			back, err := io.ReadAll(r)
			if err != nil || !bytes.Equal(back, sample) {
				t.Fatalf("%s level %d: %v", name, level, err)
			}
		}
	}
}

// the header bytes Node writes (test/shim/zlib compares them too)
func TestHeaders(t *testing.T) {
	ctx := newTestContext()
	cases := []struct {
		format string
		opts   map[string]int
		header string
	}{
		{"deflate", map[string]int{}, "789c"},
		{"deflate", map[string]int{"level": 1}, "7801"},
		{"deflate", map[string]int{"level": 4}, "785e"},
		{"deflate", map[string]int{"level": 9}, "78da"},
		{"deflate", map[string]int{"strategy": 2}, "7801"},
		{"deflate", map[string]int{"windowBits": 9}, "1895"},
		{"deflate", map[string]int{"windowBits": 8}, "1895"},
		{"gzip", map[string]int{}, "1f8b08000000000000"},
		{"gzip", map[string]int{"level": 0}, "1f8b08000000000004"},
		{"gzip", map[string]int{"level": 1}, "1f8b08000000000004"},
		{"gzip", map[string]int{"level": 9}, "1f8b08000000000002"},
		{"gzip", map[string]int{"strategy": 2}, "1f8b08000000000004"},
	}
	for _, c := range cases {
		out := must(t)(call(ctx, Compress, c.format, sample, c.opts))
		if got := hex.EncodeToString(out[:len(c.header)/2]); got != c.header {
			t.Errorf("%s %v: header %s, Node writes %s", c.format, c.opts, got, c.header)
		}
	}
}

func TestNodeVectors(t *testing.T) {
	ctx := newTestContext()
	text := vector(t, "text")
	dict := vector(t, "dictionary")
	cases := []struct {
		format, vector string
		dict           []byte
		want           []byte
	}{
		{"deflate", "deflate", nil, text},
		{"deflate", "deflate.level9", nil, text},
		{"unzip", "deflate", nil, text},
		{"deflateRaw", "deflateRaw", nil, text},
		{"gzip", "gzip", nil, text},
		{"unzip", "gzip", nil, text},
		{"gzip", "gzip.fields", nil, text},
		{"gzip", "gzip.concat", nil, []byte("first member, second member")},
		{"deflate", "deflate.dictionary", dict, text},
		{"deflateRaw", "deflateRaw.dictionary", dict, text},
		{"brotli", "brotli", nil, text},
		{"brotli", "brotli.q4", nil, text},
	}
	for _, c := range cases {
		out := must(t)(call(ctx, Decompress, c.format, vector(t, c.vector), map[string]int{"windowBits": 0}, c.dict))
		if !bytes.Equal(out, c.want) {
			t.Errorf("%s of %s: %q", c.format, c.vector, out)
		}
	}
	if crc := crc32Of(text); fmt.Sprint(crc) != nodeVectors["crc32.text"] {
		t.Errorf("crc32 %d", crc)
	}
}

// errors as Node reports them for the same input (code and errno; the
// messages are zlib's where Go can tell the case)
func TestErrors(t *testing.T) {
	ctx := newTestContext()
	deflated := vector(t, "deflate")
	gzipped := vector(t, "gzip")
	brotlied := vector(t, "brotli")
	flip := func(b []byte, i int) []byte {
		c := bytes.Clone(b)
		c[(i+len(c))%len(c)] ^= 1
		return c
	}
	cases := []struct {
		name, format string
		data, dict   []byte
		opts         map[string]int
		err          error
	}{
		{"truncated", "deflate", deflated[:50], nil, nil, errUnexpectedEnd},
		{"truncated gzip", "gzip", gzipped[:50], nil, nil, errUnexpectedEnd},
		{"truncated gzip trailer", "gzip", gzipped[:len(gzipped)-3], nil, nil, errUnexpectedEnd},
		{"truncated raw", "deflateRaw", vector(t, "deflateRaw")[:20], nil, nil, errUnexpectedEnd},
		{"empty", "deflate", []byte{}, nil, nil, errUnexpectedEnd},
		{"empty gzip", "gzip", []byte{}, nil, nil, errUnexpectedEnd},
		{"empty unzip", "unzip", []byte{}, nil, nil, errUnexpectedEnd},
		{"one byte gzip", "gzip", []byte("x"), nil, nil, errUnexpectedEnd},
		{"corrupt header", "deflate", []byte{1, 2, 3, 4}, nil, nil, errHeaderCheck},
		{"not gzip", "gzip", []byte("plain"), nil, nil, errHeaderCheck},
		{"not zlib for unzip", "unzip", []byte("plain"), nil, nil, errHeaderCheck},
		{"method", "deflate", []byte{0x79, 0x18, 1, 2}, nil, nil, errUnknownMethod},
		{"window larger than windowBits", "deflate", deflated, nil, map[string]int{"windowBits": 9}, errWindowSize},
		{"missing dictionary", "deflate", vector(t, "deflate.dictionary"), nil, nil, errMissingDict},
		{"bad dictionary", "deflate", vector(t, "deflate.dictionary"), []byte("other"), nil, errBadDict},
		{"adler32", "deflate", flip(deflated, -1), nil, nil, errDataCheck},
		{"crc32", "gzip", flip(gzipped, -6), nil, nil, errDataCheck},
		{"isize", "gzip", flip(gzipped, -1), nil, nil, errLengthCheck},
		{"trailing garbage after gzip", "gzip", append(bytes.Clone(gzipped), "garbage"...), nil, nil, errHeaderCheck},
		{"trailing 1f after gzip", "gzip", append(bytes.Clone(gzipped), 0x1f), nil, nil, errUnexpectedEnd},
		{"truncated brotli", "brotli", brotlied[:20], nil, nil, errUnexpectedEnd},
		{"empty brotli", "brotli", []byte{}, nil, nil, errUnexpectedEnd},
	}
	for _, c := range cases {
		opts := c.opts
		if opts == nil {
			opts = map[string]int{"windowBits": 0}
		}
		_, err := call(ctx, Decompress, c.format, c.data, opts, c.dict)
		if c.err == nil {
			if err == nil {
				t.Errorf("%s: no error", c.name)
			}
			continue
		}
		if err != c.err {
			t.Errorf("%s: %v, want %v", c.name, err, c.err)
		}
	}

	_, err := call(ctx, Decompress, "deflateRaw", vector(t, "deflateRaw.dictionary"), map[string]int{})
	if err == nil || !strings.HasPrefix(err.Error(), "Error|Z_DATA_ERROR|-3|") {
		t.Errorf("raw deflate without its dictionary: %v", err)
	}
	_, err = call(ctx, Decompress, "brotli", []byte("hello world garbage"), map[string]int{})
	if err == nil || err.Error() != "Error|ERR__ERROR_FORMAT_CL_SPACE|-6|Decompression failed" {
		t.Errorf("corrupt brotli: %v", err)
	}
	if errUnexpectedEnd.Error() != "Error|Z_BUF_ERROR|-5|unexpected end of file" {
		t.Errorf("error format %s", errUnexpectedEnd)
	}
}

// what follows the data, as Node treats it
func TestTrailingData(t *testing.T) {
	ctx := newTestContext()
	text := vector(t, "text")
	cases := []struct{ format, vector, trailing string }{
		{"deflate", "deflate", "garbage"},
		{"deflateRaw", "deflateRaw", "garbage"},
		{"brotli", "brotli", "garbage"},
		{"gzip", "gzip", "\x00\x00\x00garbage"},
	}
	for _, c := range cases {
		data := append(vector(t, c.vector), c.trailing...)
		out := must(t)(call(ctx, Decompress, c.format, data, map[string]int{}))
		if !bytes.Equal(out, text) {
			t.Errorf("%s with trailing data: %d bytes", c.format, len(out))
		}
	}
}

func TestFinishFlush(t *testing.T) {
	ctx := newTestContext()
	// what Node's inflateSync gives for every prefix of its own output with
	// finishFlush Z_SYNC_FLUSH (every symbol complete in the input), one-shot
	// and as a stream
	texts := map[string][]byte{
		"deflate":    vector(t, "text"),
		"deflate500": []byte(strings.Repeat("The quick brown fox jumps over the lazy dog. ", 500) + "€😀"),
	}
	for name, text := range texts {
		deflated := vector(t, name)
		for i, length := range strings.Split(nodeVectors[name+".prefixes"], ",") {
			truncated := deflated[:i+3]
			n, _ := strconv.Atoi(length)
			want := text[:n]
			out := must(t)(call(ctx, Decompress, "deflate", truncated, map[string]int{"finishFlush": zSyncFlush}))
			h := create(t, ctx, "deflate", "decompress", map[string]int{}, nil)
			streamed := must(t)(call(ctx, StreamWrite, h, truncated, zNoFlush))
			call(ctx, Free, h)
			if !bytes.Equal(out, want) || !bytes.Equal(streamed, want) {
				t.Errorf("%s, %d bytes with Z_SYNC_FLUSH: %d bytes (stream %d), Node gives %s", name, i+3, len(out), len(streamed), length)
			}
		}
	}

	// compression that ends on a sync flush: no trailer, decodable so far
	flushed := must(t)(call(ctx, Compress, "deflate", sample, map[string]int{"finishFlush": zSyncFlush}))
	if !bytes.HasSuffix(flushed, []byte{0, 0, 0xff, 0xff}) {
		t.Errorf("sync flush marker missing")
	}
	back := must(t)(call(ctx, Decompress, "deflate", flushed, map[string]int{"finishFlush": zSyncFlush}))
	if !bytes.Equal(back, sample) {
		t.Errorf("sync-flushed one-shot: %d bytes", len(back))
	}
}

func TestMaxOutputLength(t *testing.T) {
	ctx := newTestContext()
	deflated := must(t)(call(ctx, Compress, "deflate", sample, map[string]int{}))
	_, err := call(ctx, Decompress, "deflate", deflated, map[string]int{"maxOutputLength": 100})
	if err == nil || err.Error() != "RangeError|ERR_BUFFER_TOO_LARGE||Cannot create a Buffer larger than 100 bytes" {
		t.Errorf("decompress: %v", err)
	}
	exact := must(t)(call(ctx, Decompress, "deflate", deflated, map[string]int{"maxOutputLength": len(sample)}))
	if len(exact) != len(sample) {
		t.Errorf("an output of exactly maxOutputLength fails")
	}
	_, err = call(ctx, Compress, "gzip", sample, map[string]int{"maxOutputLength": 10})
	if errCode(err) != "ERR_BUFFER_TOO_LARGE" {
		t.Errorf("compress: %v", err)
	}
	_, err = call(ctx, Decompress, "brotli", vector(t, "brotli"), map[string]int{"maxOutputLength": 10})
	if errCode(err) != "ERR_BUFFER_TOO_LARGE" {
		t.Errorf("brotli: %v", err)
	}
}

// streams

func create(t *testing.T, ctx *types.Context, format, direction string, opts any, dict []byte) float64 {
	t.Helper()
	out, err := call(ctx, StreamCreate, format, direction, opts, dict)
	if err != nil {
		t.Fatal(err)
	}
	return out.(float64)
}

// pieces cuts b in pieces of 1 to 3 bytes
func pieces(b []byte) [][]byte {
	var out [][]byte
	for i := 0; len(b) > 0; i++ {
		n := min(i%3+1, len(b))
		out = append(out, b[:n])
		b = b[n:]
	}
	return out
}

// ssh2's use: each packet compressed and flushed, the other side decodes
// each one completely from its compressed bytes, which arrive in pieces
func TestStreamFlushBothWays(t *testing.T) {
	ctx := newTestContext()
	for _, format := range []string{"deflate", "deflateRaw", "gzip", "brotli"} {
		flush := zSyncFlush
		if format == "brotli" {
			flush = brotliOperationFlush
		}
		deflate := create(t, ctx, format, "compress", map[string]int{}, nil)
		inflate := create(t, ctx, format, "decompress", map[string]int{"windowBits": 0}, nil)
		for i := range 30 {
			packet := fmt.Appendf(nil, "packet %d: %s", i, sample[:i*37])
			var compressed []byte
			for _, p := range pieces(packet) {
				compressed = append(compressed, must(t)(call(ctx, StreamWrite, deflate, p, zNoFlush))...)
			}
			compressed = append(compressed, must(t)(call(ctx, StreamWrite, deflate, []byte{}, flush))...)
			var decoded []byte
			for _, p := range pieces(compressed) {
				decoded = append(decoded, must(t)(call(ctx, StreamWrite, inflate, p, zNoFlush))...)
			}
			if !bytes.Equal(decoded, packet) {
				t.Fatalf("%s packet %d: decoded %q", format, i, decoded)
			}
		}
		trailer := must(t)(call(ctx, StreamEnd, deflate))
		if rest := must(t)(call(ctx, StreamWrite, inflate, trailer, zNoFlush)); len(rest) != 0 {
			t.Fatalf("%s: output after the trailer", format)
		}
		if _, err := call(ctx, StreamEnd, inflate); err != nil {
			t.Fatalf("%s end: %v", format, err)
		}
	}
	if len(ctx.Zlib) != 0 {
		t.Errorf("%d handles left", len(ctx.Zlib))
	}
}

// OpenSSH flushes with Z_PARTIAL_FLUSH: the empty fixed block that follows
// each packet ends in the next one. Node's output, as ssh2 receives it.
func TestStreamPartialFlushFromNode(t *testing.T) {
	ctx := newTestContext()
	for _, name := range []string{"flush.partial", "flush.sync"} {
		inflate := create(t, ctx, "deflate", "decompress", map[string]int{"windowBits": 15}, nil)
		packets := []string{"first packet", "second packet, longer than the first one", "third"}
		for i, h := range strings.Split(nodeVectors[name], ",") {
			data, _ := hex.DecodeString(h)
			out := must(t)(call(ctx, StreamWrite, inflate, data, zPartialFlush))
			if string(out) != packets[i] {
				t.Errorf("%s packet %d: %q", name, i, out)
			}
		}
		call(ctx, Free, inflate)
	}
}

func TestStreamTruncated(t *testing.T) {
	ctx := newTestContext()
	deflated := vector(t, "deflate")
	text := vector(t, "text")

	inflate := create(t, ctx, "deflate", "decompress", map[string]int{}, nil)
	out := must(t)(call(ctx, StreamWrite, inflate, deflated[:50], zNoFlush))
	if _, err := call(ctx, StreamEnd, inflate); err != errUnexpectedEnd {
		t.Errorf("end of a truncated stream: %v", err)
	}

	// finishFlush Z_SYNC_FLUSH: what the input allows, no error
	inflate = create(t, ctx, "deflate", "decompress", map[string]int{}, nil)
	out = must(t)(call(ctx, StreamWrite, inflate, deflated[:50], zNoFlush))
	rest, err := call(ctx, StreamEnd, inflate, zSyncFlush)
	if err != nil {
		t.Fatal(err)
	}
	out = append(out, rest.([]byte)...)
	if !bytes.Equal(out, text[:46]) {
		t.Errorf("truncated with finishFlush Z_SYNC_FLUSH: %q", out)
	}

	// an inflate stream ended without input fails as inflateSync(empty)
	inflate = create(t, ctx, "gzip", "decompress", map[string]int{}, nil)
	if _, err := call(ctx, StreamEnd, inflate); err != errUnexpectedEnd {
		t.Errorf("end without input: %v", err)
	}
}

func TestStreamParamsAndReset(t *testing.T) {
	ctx := newTestContext()
	deflate := create(t, ctx, "deflate", "compress", map[string]int{"level": 1}, nil)
	var compressed []byte
	compressed = append(compressed, must(t)(call(ctx, StreamWrite, deflate, sample, zNoFlush))...)
	compressed = append(compressed, must(t)(call(ctx, StreamParams, deflate, 9, 0))...)
	compressed = append(compressed, must(t)(call(ctx, StreamWrite, deflate, sample, zNoFlush))...)
	compressed = append(compressed, must(t)(call(ctx, StreamParams, deflate, 0, 2))...)
	compressed = append(compressed, must(t)(call(ctx, StreamWrite, deflate, sample, zFinish))...)
	back := must(t)(call(ctx, Decompress, "deflate", compressed, map[string]int{}))
	if !bytes.Equal(back, bytes.Repeat(sample, 3)) {
		t.Fatalf("params: %d bytes back", len(back))
	}

	// reset: a new stream from the next write, with a new header
	must(t)(call(ctx, StreamWrite, deflate, []byte("dropped"), zSyncFlush))
	if _, err := call(ctx, StreamReset, deflate); err != nil {
		t.Fatal(err)
	}
	out := must(t)(call(ctx, StreamEnd, deflate))
	if back := must(t)(call(ctx, Decompress, "deflate", out, map[string]int{})); len(back) != 0 {
		t.Errorf("reset kept data: %q", back)
	}

	inflate := create(t, ctx, "gzip", "decompress", map[string]int{}, nil)
	gzipped := vector(t, "gzip")
	must(t)(call(ctx, StreamWrite, inflate, gzipped[:40], zNoFlush))
	call(ctx, StreamReset, inflate)
	out = must(t)(call(ctx, StreamWrite, inflate, gzipped, zNoFlush))
	if !bytes.Equal(out, vector(t, "text")) {
		t.Errorf("inflate after reset: %d bytes", len(out))
	}
	call(ctx, Free, inflate)
}

func TestStreamDictionary(t *testing.T) {
	ctx := newTestContext()
	dict := vector(t, "dictionary")
	inflate := create(t, ctx, "deflate", "decompress", map[string]int{}, dict)
	// the call payload the dictionary came in is reused by the next call
	for i := range dict {
		dict[i] = 0
	}
	var out []byte
	for _, p := range pieces(vector(t, "deflate.dictionary")) {
		out = append(out, must(t)(call(ctx, StreamWrite, inflate, p, zNoFlush))...)
	}
	if !bytes.Equal(out, vector(t, "text")) {
		t.Errorf("dictionary stream: %q", out)
	}
	call(ctx, Free, inflate)
}

func TestStreamErrors(t *testing.T) {
	ctx := newTestContext()
	inflate := create(t, ctx, "gzip", "decompress", map[string]int{}, nil)
	_, err := call(ctx, StreamWrite, inflate, []byte("not gzip data"), zNoFlush)
	if err != errHeaderCheck {
		t.Errorf("stream error: %v", err)
	}
	call(ctx, Free, inflate)
	if _, err := call(ctx, StreamWrite, inflate, []byte("x"), zNoFlush); err != errInvalidHandle {
		t.Errorf("freed handle: %v", err)
	}
	if _, err := call(ctx, StreamCreate, "unzip", "compress", map[string]int{}); err == nil {
		t.Errorf("unzip compression")
	}
}

// no goroutine outlives its stream: Free, StreamEnd and the end of the
// context (Close) stop them, whatever the decoder was waiting for
func TestStreamGoroutines(t *testing.T) {
	ctx := newTestContext()
	before := runtime.NumGoroutine()
	deflated := vector(t, "deflate")
	var handles []float64
	for i := range 60 {
		h := create(t, ctx, []string{"deflate", "unzip", "brotli"}[i%3], "decompress", map[string]int{}, nil)
		data := deflated[:10+i]
		if i%3 == 2 {
			data = vector(t, "brotli")[:10+i]
		}
		call(ctx, StreamWrite, h, data, zNoFlush)
		handles = append(handles, h)
	}
	if runtime.NumGoroutine() < before+60 {
		t.Fatalf("decoders not running")
	}
	for i, h := range handles {
		switch i % 3 {
		case 0:
			call(ctx, Free, h)
		case 1:
			call(ctx, StreamEnd, h)
		}
	}
	// what EndContext does with the rest
	for _, s := range ctx.Zlib {
		s.(interface{ Close() }).Close()
	}
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if n := runtime.NumGoroutine(); n > before {
		t.Errorf("%d goroutines left", n-before)
	}
}

func TestHandleLimit(t *testing.T) {
	ctx := newTestContext()
	for range maxHandles {
		create(t, ctx, "deflate", "compress", map[string]int{}, nil)
	}
	if _, err := call(ctx, StreamCreate, "deflate", "compress", map[string]int{}); err != errTooManyHandles {
		t.Errorf("past the limit: %v", err)
	}
	ctx.Zlib = nil
	if _, err := call(ctx, StreamCreate, "deflate", "compress", map[string]int{}); err != errContextEnded {
		t.Errorf("ended context: %v", err)
	}
}

func crc32Of(b []byte) uint32 {
	return crc32.ChecksumIEEE(b)
}
