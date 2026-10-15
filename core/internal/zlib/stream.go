package zlib

import (
	"bytes"
	"fullstackedorg/fullstacked/types"
	"io"
	"math"
	"sync"
)

// stream is a compression or decompression stream of the page (createGzip()
// and friends, ssh2's packet compression): the encoder writes into out; the
// decoder runs on a feed, started by the first write.
type stream struct {
	mu       sync.Mutex
	format   format
	compress bool
	opts     options
	dict     []byte

	enc *encoder
	out bytes.Buffer

	feed *feed
}

func newStream(f format, compress bool, o options, dict []byte) (*stream, error) {
	s := &stream{
		format:   f,
		compress: compress,
		opts:     o,
		// kept for reset(): the payload it comes from is gone after the call
		dict: bytes.Clone(dict),
	}
	return s, s.reset()
}

// reset starts over with the same options, as zlib's deflateReset and
// inflateReset (Node's reset()). Called with mu held or before the stream
// is shared.
func (s *stream) reset() error {
	if s.feed != nil {
		s.feed.stop()
		s.feed = nil
	}
	s.out.Reset()
	if !s.compress {
		return nil
	}
	enc, err := newEncoder(s.format, s.opts, s.dict, &s.out)
	s.enc = enc
	return err
}

// write is one zlib deflate() or inflate() call: data, then the flush value
func (s *stream) write(data []byte, flush int) ([]byte, error) {
	if s.compress {
		if err := s.enc.writeFlush(data, flush); err != nil {
			return nil, outputError(err)
		}
		return s.takeOutput(), nil
	}

	finish := isFinish(s.format, flush)
	if s.feed == nil {
		if len(data) == 0 && !finish {
			return nil, nil
		}
		s.feed = newFeed()
		f, o, dict := s.format, s.opts, s.dict
		s.feed.start(func(in input, out io.Writer) error {
			return decode(f, o, dict, in, out)
		})
	}
	out, err := s.feed.push(data, finish)
	if err != nil {
		return nil, outputError(err)
	}
	return out, nil
}

// takeOutput hands out the encoder's output; the buffer is not reused, the
// response still points to it after the call returns
func (s *stream) takeOutput() []byte {
	if s.out.Len() == 0 {
		return nil
	}
	out := s.out.Bytes()
	s.out = bytes.Buffer{}
	return out
}

// end finishes the stream (finishFlush, Z_FINISH by default) and stops it.
// With another finishFlush a truncated input is not an error, as in Node.
func (s *stream) end(finishFlush int) ([]byte, error) {
	if s.compress {
		return s.write(nil, finishFlush)
	}
	if s.feed == nil {
		if !isFinish(s.format, finishFlush) {
			return nil, nil
		}
		return s.write(nil, finishFlush)
	}
	if !isFinish(s.format, finishFlush) {
		// what the input allows was handed out at the last write
		out, _ := s.feed.push(nil, false)
		return out, nil
	}
	return s.write(nil, finishFlush)
}

// Close stops the decoder goroutine; EndContext calls it on what the page
// left open
func (s *stream) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.feed != nil {
		s.feed.stop()
		s.feed = nil
	}
}

func streamCreate(ctx *types.Context, a args) (any, error) {
	direction := a.str(1)
	compress := direction == "compress"
	if !compress && direction != "decompress" {
		return nil, errUnknownFormat
	}
	f, err := parseFormat(a.str(0), compress)
	if err != nil {
		return nil, err
	}
	o, err := parseOptions(a, 2)
	if err != nil {
		return nil, err
	}
	s, err := newStream(f, compress, o, a.buf(3))
	if err != nil {
		return nil, err
	}
	id, err := newHandle(ctx, s)
	return float64(id), err
}

func streamWrite(ctx *types.Context, a args) (any, error) {
	s, err := getHandle(ctx, a, false)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.write(a.buf(1), a.int(2, zNoFlush))
}

func streamEnd(ctx *types.Context, a args) (any, error) {
	s, err := getHandle(ctx, a, true)
	if err != nil {
		return nil, err
	}
	finishFlush := zFinish
	if s.format == formatBrotli {
		finishFlush = brotliOperationFinish
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	defer func() {
		if s.feed != nil {
			s.feed.stop()
			s.feed = nil
		}
	}()
	return s.end(a.int(1, finishFlush))
}

func streamParams(ctx *types.Context, a args) (any, error) {
	s, err := getHandle(ctx, a, false)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.enc == nil {
		return nil, nil
	}
	s.opts.Level = a.int(1, zDefaultCompression)
	s.opts.Strategy = a.int(2, 0)
	if err := s.enc.params(s.opts.Level, s.opts.Strategy); err != nil {
		return nil, outputError(err)
	}
	return s.takeOutput(), nil
}

func streamReset(ctx *types.Context, a args) (any, error) {
	s, err := getHandle(ctx, a, false)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return nil, s.reset()
}

// A page that drops streams without ending them (and without its
// FinalizationRegistry catching up) fails new ones instead of growing the
// context without bound. A decompression stream holds a goroutine and a 32
// KB window.
const maxHandles = 1024

// newHandle keeps s in the context. Ids start at 1, are never 0 and move
// forward until they wrap, so a stale id from the page does not hit a newer
// stream right away.
func newHandle(ctx *types.Context, s *stream) (uint32, error) {
	ctx.ZlibMutex.Lock()
	defer ctx.ZlibMutex.Unlock()

	if ctx.Zlib == nil {
		return 0, errContextEnded
	}
	if len(ctx.Zlib) >= maxHandles {
		return 0, errTooManyHandles
	}

	id := ctx.NextZlibId
	for {
		if id == 0 {
			id = 1
		}
		if _, used := ctx.Zlib[id]; !used {
			break
		}
		id++
	}

	ctx.Zlib[id] = s
	ctx.NextZlibId = id + 1
	return id, nil
}

func handleId(a args) (uint32, bool) {
	n := a.num(0, 0)
	if n < 1 || n > math.MaxUint32 || n != math.Trunc(n) {
		return 0, false
	}
	return uint32(n), true
}

// getHandle returns the stream of the handle in argument 0, take removes it
// from the context as well
func getHandle(ctx *types.Context, a args, take bool) (*stream, error) {
	id, ok := handleId(a)
	if !ok {
		return nil, errInvalidHandle
	}

	ctx.ZlibMutex.Lock()
	defer ctx.ZlibMutex.Unlock()

	s, ok := ctx.Zlib[id].(*stream)
	if !ok {
		return nil, errInvalidHandle
	}
	if take {
		delete(ctx.Zlib, id)
	}
	return s, nil
}

// freeHandle drops a stream, an unknown one is not an error: the page's
// FinalizationRegistry may run after StreamEnd
func freeHandle(ctx *types.Context, a args) (any, error) {
	id, ok := handleId(a)
	if !ok {
		return nil, nil
	}

	ctx.ZlibMutex.Lock()
	s, _ := ctx.Zlib[id].(*stream)
	if ctx.Zlib != nil {
		delete(ctx.Zlib, id)
	}
	ctx.ZlibMutex.Unlock()

	if s != nil {
		s.Close()
	}
	return nil, nil
}
