package zlib

import (
	"bytes"
	"encoding/binary"
	"hash"
	"hash/adler32"
	"hash/crc32"
	"io"

	"github.com/andybalholm/brotli"
	"github.com/klauspost/compress/flate"
)

// encoder compresses into out. The zlib and gzip wrappers are written here
// rather than with compress/zlib and compress/gzip: Node's headers (level
// bits, XFL, the OS byte) and windowBits need them byte for byte.
type encoder struct {
	format format
	opts   options
	dict   []byte
	out    io.Writer

	fw *flate.Writer
	bw *brotli.Writer

	sum     hash.Hash32 // Adler-32 (zlib) or CRC-32 (gzip) of the input
	size    uint32      // gzip ISIZE: the input length modulo 2^32
	started bool        // the header is written
	// written since the last flush: params() flushes only then
	dirty    bool
	finished bool
}

func newEncoder(f format, o options, dict []byte, out io.Writer) (*encoder, error) {
	e := &encoder{format: f, opts: o, dict: dict, out: out}
	switch f {
	case formatBrotli:
		e.bw = brotli.NewWriterOptions(out, brotli.WriterOptions{
			Quality: o.Quality,
			LGWin:   o.LgWin,
		})
		return e, nil
	case formatDeflate:
		e.sum = adler32.New()
	case formatGzip:
		e.sum = crc32.NewIEEE()
		// zlib ignores a dictionary for gzip, so does Node
		e.dict = nil
	}
	return e, e.newFlateWriter()
}

// flateLevel maps Node's level and strategy on klauspost/compress's flate
// (the standard library's is 2.2x slower than zlib at the default level;
// klauspost's levels 1-6 trade some ratio for speed, see improvements/shim/plan.md
// Stage 5). Z_FILTERED,
// Z_RLE and Z_FIXED have no equivalent and compress as the default strategy,
// which gives a valid stream. Below a 32 KB window (windowBits < 15)
// the encoder's matches could reach further back than the window the
// header announces: Huffman-only coding has no matches at all.
func (e *encoder) flateLevel() int {
	level := e.opts.Level
	if level == 0 {
		return flate.NoCompression
	}
	if e.opts.Strategy == zHuffmanOnly || e.opts.WindowBits < 15 {
		return flate.HuffmanOnly
	}
	if level < 0 || level > 9 {
		return flate.DefaultCompression
	}
	return level
}

func (e *encoder) newFlateWriter() error {
	var err error
	if len(e.dict) > 0 {
		e.fw, err = flate.NewWriterDict(e.out, e.flateLevel(), e.dict)
	} else {
		e.fw, err = flate.NewWriter(e.out, e.flateLevel())
	}
	if err != nil {
		return errOperationFailed
	}
	return nil
}

// header writes the zlib or gzip header, as zlib's deflate() does
func (e *encoder) header() error {
	e.started = true
	switch e.format {
	case formatDeflate:
		windowBits := max(e.opts.WindowBits, 9) // zlib turns 8 into 9
		cmf := byte((windowBits-8)<<4 | 8)
		level := e.opts.Level
		if level < 0 {
			level = 6
		}
		var flg byte
		switch {
		case e.opts.Strategy >= zHuffmanOnly || level < 2:
			flg = 0
		case level < 6:
			flg = 1
		case level == 6:
			flg = 2
		default:
			flg = 3
		}
		flg <<= 6
		if len(e.dict) > 0 {
			flg |= 0x20
		}
		flg += byte(31 - (uint(cmf)<<8+uint(flg))%31)
		h := []byte{cmf, flg}
		if len(e.dict) > 0 {
			h = binary.BigEndian.AppendUint32(h, adler32.Checksum(e.dict))
		}
		_, err := e.out.Write(h)
		return err
	case formatGzip:
		// no name, no mtime; XFL as zlib sets it, OS 3 (Unix) as Node on
		// Linux and macOS
		xfl := byte(0)
		if e.opts.Level == 9 {
			xfl = 2
		} else if e.opts.Strategy >= zHuffmanOnly || (e.opts.Level >= 0 && e.opts.Level < 2) {
			xfl = 4
		}
		_, err := e.out.Write([]byte{0x1f, 0x8b, 8, 0, 0, 0, 0, 0, xfl, 3})
		return err
	}
	return nil
}

func (e *encoder) write(p []byte) error {
	if e.finished {
		return nil
	}
	if e.bw != nil {
		_, err := e.bw.Write(p)
		return err
	}
	if !e.started {
		if err := e.header(); err != nil {
			return err
		}
	}
	if len(p) == 0 {
		return nil
	}
	e.dirty = true
	if e.sum != nil {
		e.sum.Write(p)
	}
	e.size += uint32(len(p))
	_, err := e.fw.Write(p)
	return err
}

// flush outputs everything written so far: a sync flush (an empty stored
// block) for deflate, which a decoder reads as well as zlib's partial and
// full flushes; Z_FULL_FLUSH does not reset the match window here
func (e *encoder) flush() error {
	if e.finished {
		return nil
	}
	if e.bw != nil {
		return e.bw.Flush()
	}
	if !e.started {
		if err := e.header(); err != nil {
			return err
		}
	}
	e.dirty = false
	return e.fw.Flush()
}

func (e *encoder) finish() error {
	if e.finished {
		return nil
	}
	e.finished = true
	if e.bw != nil {
		return e.bw.Close()
	}
	if !e.started {
		if err := e.header(); err != nil {
			return err
		}
	}
	if err := e.fw.Close(); err != nil {
		return err
	}
	var trailer []byte
	switch e.format {
	case formatDeflate:
		trailer = binary.BigEndian.AppendUint32(nil, e.sum.Sum32())
	case formatGzip:
		trailer = binary.LittleEndian.AppendUint32(nil, e.sum.Sum32())
		trailer = binary.LittleEndian.AppendUint32(trailer, e.size)
	default:
		return nil
	}
	_, err := e.out.Write(trailer)
	return err
}

// writeFlush writes p then applies the flush value, as one zlib deflate()
// call with that flush
func (e *encoder) writeFlush(p []byte, flush int) error {
	if err := e.write(p); err != nil {
		return err
	}
	switch {
	case isFinish(e.format, flush):
		return e.finish()
	case isFlush(e.format, flush):
		return e.flush()
	}
	return nil
}

// params is Node's params(): the flate writer cannot change level on the way,
// so the writer is flushed (the stream so far ends on a byte boundary) and a
// new one continues the same deflate stream with the new level. The new
// writer starts without the previous window, which costs ratio only.
func (e *encoder) params(level, strategy int) error {
	if e.bw != nil || e.finished {
		return nil
	}
	e.opts.Level = level
	e.opts.Strategy = strategy
	if !e.started {
		return e.newFlateWriter()
	}
	if e.dirty {
		if err := e.flush(); err != nil {
			return err
		}
	}
	// a preset dictionary would read as data preceding the new writer's
	// output, the decoder's window holds the stream's own output instead
	e.dict = nil
	return e.newFlateWriter()
}

// compressAll is the one-shot compression: the input, then finishFlush
func compressAll(f format, o options, dict []byte, data []byte) ([]byte, error) {
	out := newOutput(o.MaxOutputLength, len(data)/4+64)
	e, err := newEncoder(f, o, dict, out)
	if err != nil {
		return nil, err
	}
	if err := e.writeFlush(data, o.FinishFlush); err != nil {
		return nil, outputError(err)
	}
	return out.Bytes(), nil
}

// output collects what a call returns, failing past maxOutputLength
type output struct {
	bytes.Buffer
	max int
}

func newOutput(max int, size int) *output {
	out := &output{max: max}
	if max > 0 && size > max+1 {
		size = max + 1
	}
	out.Grow(size)
	return out
}

type tooLargeError struct{ max int }

func (e tooLargeError) Error() string { return errTooLarge(e.max).Error() }

func (o *output) Write(p []byte) (int, error) {
	if o.max > 0 && o.Len()+len(p) > o.max {
		return 0, tooLargeError{o.max}
	}
	return o.Buffer.Write(p)
}

// outputError maps what the writers return (the output's own error comes
// back through the flate and brotli writers unchanged)
func outputError(err error) error {
	switch err := err.(type) {
	case tooLargeError:
		return errTooLarge(err.max)
	case *nodeError:
		return err
	}
	return errOperationFailed
}
