// Package zlib runs the compression of Node's zlib module (improvements/shim/plan.md 5.3):
// deflate, zlib, gzip and brotli, one-shot or as streams. A stream is a
// handle kept in the context (stream.go); decompression streams run their
// decoder on a goroutine fed with the chunks the page pushes (feed.go).
// Errors are "<Class>|<code>|<errno>|<message>" strings the JS side turns
// back into Node errors, see errors.go.
//
// Arguments: format is "deflate" (zlib wrapper), "deflateRaw", "gzip",
// "unzip" (decompression only: gzip or zlib, from the header) or "brotli";
// options is an object (options.go) and the dictionary, when there is one,
// a separate buffer argument after it, so its bytes need no base64.
//
//	Compress     (format, data, options, dictionary?) -> bytes
//	Decompress   (format, data, options, dictionary?) -> bytes
//	StreamCreate (format, "compress"|"decompress", options, dictionary?) -> handle
//	StreamWrite  (handle, data, flush) -> the output the input so far allows
//	StreamEnd    (handle, finishFlush?) -> the trailing output; frees the handle
//	StreamParams (handle, level, strategy) -> output flushed before the change
//	StreamReset  (handle)
//	Free         (handle)
package zlib

import (
	"encoding/json"
	"fullstackedorg/fullstacked/types"
)

type ZlibFn = uint8

const (
	Compress     ZlibFn = 0
	Decompress   ZlibFn = 1
	StreamCreate ZlibFn = 2
	StreamWrite  ZlibFn = 3
	StreamEnd    ZlibFn = 4
	StreamParams ZlibFn = 5
	StreamReset  ZlibFn = 6
	Free         ZlibFn = 7
)

type fnImpl = func(ctx *types.Context, a args) (any, error)

var fns = map[ZlibFn]fnImpl{
	Compress:     compressOneShot,
	Decompress:   decompressOneShot,
	StreamCreate: streamCreate,
	StreamWrite:  streamWrite,
	StreamEnd:    streamEnd,
	StreamParams: streamParams,
	StreamReset:  streamReset,
	Free:         freeHandle,
}

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) (err error) {
	fn, ok := fns[header.Fn]
	if !ok {
		return errOperationFailed
	}

	// a malformed call (wrong argument types) must not take the core down
	defer func() {
		if r := recover(); r != nil {
			err = errOperationFailed
		}
	}()

	result, err := fn(ctx, args(data))
	if err != nil {
		return err
	}

	response.Type = types.CoreResponseData
	response.Data = result
	return nil
}

func compressOneShot(ctx *types.Context, a args) (any, error) {
	f, err := parseFormat(a.str(0), true)
	if err != nil {
		return nil, err
	}
	o, err := parseOptions(a, 2)
	if err != nil {
		return nil, err
	}
	return compressAll(f, o, a.buf(3), a.buf(1))
}

func decompressOneShot(ctx *types.Context, a args) (any, error) {
	f, err := parseFormat(a.str(0), false)
	if err != nil {
		return nil, err
	}
	o, err := parseOptions(a, 2)
	if err != nil {
		return nil, err
	}
	return decompressAll(f, o, a.buf(3), a.buf(1))
}

// args are the positional call arguments. Optional ones come as undefined
// and trailing ones may be missing, every getter treats both the same.
type args []types.DeserializedData

func (a args) defined(i int) bool {
	return i < len(a) && a[i].Type != types.UNDEFINED
}

func (a args) str(i int) string {
	if i < len(a) && a[i].Type == types.STRING {
		return a[i].Data.(string)
	}
	return ""
}

// buf reads a buffer argument, a string is taken as its UTF-8 bytes. The
// bytes alias the call payload: they are not kept after the call returns.
func (a args) buf(i int) []byte {
	if i >= len(a) {
		return nil
	}
	switch a[i].Type {
	case types.BUFFER:
		return a[i].Data.([]byte)
	case types.STRING:
		return []byte(a[i].Data.(string))
	}
	return nil
}

func (a args) num(i int, fallback float64) float64 {
	if i < len(a) && a[i].Type == types.NUMBER {
		return a[i].Data.(float64)
	}
	return fallback
}

func (a args) int(i int, fallback int) int {
	return int(a.num(i, float64(fallback)))
}

// object unmarshals an object argument
func (a args) object(i int, v any) error {
	if i < len(a) && a[i].Type == types.OBJECT {
		return json.Unmarshal(a[i].Data.(types.DeserializedRawObject).Data, v)
	}
	return nil
}
