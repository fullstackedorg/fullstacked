package zlib

import (
	"bytes"
	"encoding/binary"
	"errors"
	"hash"
	"hash/adler32"
	"hash/crc32"
	"io"
	"strings"

	"fullstackedorg/fullstacked/internal/zlib/flate"

	"github.com/andybalholm/brotli"
)

// input is what the decoders read: a bytes.Reader for one-shot calls, a
// feed for streams. Reading byte by byte (io.ByteReader) keeps flate from
// reading past the end of the deflate data into the trailer.
type input interface {
	io.Reader
	io.ByteReader
}

// pendingFlusher is an input that may wait for more data (a feed): before
// it waits, it calls the function set here, which hands out what the
// decoder has decoded and not returned yet
type pendingFlusher interface {
	onWait(func())
}

// pender is the vendored flate decompressor (internal/zlib/flate)
type pender interface {
	Pending() []byte
}

var errStopped = errors.New("zlib stream stopped")

// decode decompresses the whole input of format f into out, the way zlib's
// inflate() with Node's options does. The end of the input before the end
// of the data is errUnexpectedEnd, after everything decodable was written.
func decode(f format, o options, dict []byte, in input, out io.Writer) error {
	d := decoding{opts: o, dict: dict, in: in, out: out}
	switch f {
	case formatDeflate:
		cmf, flg, err := d.read2()
		if err != nil {
			return err
		}
		return d.zlib(cmf, flg)
	case formatDeflateRaw:
		return d.deflate(dict, nil)
	case formatGzip:
		id1, id2, err := d.read2()
		if err != nil {
			return err
		}
		return d.gzip(id1, id2)
	case formatUnzip:
		// zlib's automatic header detection: 1f 8b is gzip, anything else
		// a zlib header
		b0, b1, err := d.read2()
		if err != nil {
			return err
		}
		if b0 == 0x1f && b1 == 0x8b {
			return d.gzip(b0, b1)
		}
		return d.zlib(b0, b1)
	case formatBrotli:
		return d.brotli()
	}
	return errUnknownFormat
}

type decoding struct {
	opts options
	dict []byte
	in   input
	out  io.Writer
	buf  []byte
}

func (d *decoding) readByte() (byte, error) {
	b, err := d.in.ReadByte()
	if err != nil {
		return 0, inputError(err)
	}
	return b, nil
}

func (d *decoding) read2() (byte, byte, error) {
	b0, err := d.readByte()
	if err != nil {
		return 0, 0, err
	}
	b1, err := d.readByte()
	return b0, b1, err
}

func (d *decoding) readFull(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := io.ReadFull(d.in, b); err != nil {
		return nil, inputError(err)
	}
	return b, nil
}

// inputError: the end of the input where the format needs more is zlib's
// Z_BUF_ERROR
func inputError(err error) error {
	if err == io.EOF || err == io.ErrUnexpectedEOF {
		return errUnexpectedEnd
	}
	return err
}

// zlib checks the RFC 1950 header as inflate() does, then the data and its
// Adler-32
func (d *decoding) zlib(cmf, flg byte) error {
	if (uint(cmf)<<8|uint(flg))%31 != 0 {
		return errHeaderCheck
	}
	if cmf&0x0f != 8 {
		return errUnknownMethod
	}
	window := int(cmf>>4) + 8
	if window > 15 || (d.opts.WindowBits != 0 && window > d.opts.WindowBits) {
		return errWindowSize
	}
	var dict []byte
	if flg&0x20 != 0 {
		id, err := d.readFull(4)
		if err != nil {
			return err
		}
		if len(d.dict) == 0 {
			return errMissingDict
		}
		if binary.BigEndian.Uint32(id) != adler32.Checksum(d.dict) {
			return errBadDict
		}
		dict = d.dict
	}
	sum := adler32.New()
	if err := d.deflate(dict, sum); err != nil {
		return err
	}
	trailer, err := d.readFull(4)
	if err != nil {
		return err
	}
	if binary.BigEndian.Uint32(trailer) != sum.Sum32() {
		return errDataCheck
	}
	return nil
}

// gzip decodes the members of a gzip stream. After a member, zlib in Node
// goes on while input remains and its next byte is not 0: another member,
// or trailing garbage that fails as a header. Zero bytes end the stream
// (padding).
func (d *decoding) gzip(id1, id2 byte) error {
	for {
		if err := d.gzipMember(id1, id2); err != nil {
			return err
		}
		next, err := d.in.ReadByte()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		if next == 0 {
			return nil
		}
		id1 = next
		if id2, err = d.readByte(); err != nil {
			return err
		}
	}
}

const (
	gzipFlagHcrc    = 1 << 1
	gzipFlagExtra   = 1 << 2
	gzipFlagName    = 1 << 3
	gzipFlagComment = 1 << 4
)

func (d *decoding) gzipMember(id1, id2 byte) error {
	if id1 != 0x1f || id2 != 0x8b {
		return errHeaderCheck
	}
	header := crc32.NewIEEE()
	header.Write([]byte{id1, id2})
	fixed, err := d.readFull(8) // CM, FLG, MTIME, XFL, OS
	if err != nil {
		return err
	}
	header.Write(fixed)
	if fixed[0] != 8 {
		return errUnknownMethod
	}
	flags := fixed[1]
	if flags&0xe0 != 0 {
		return errHeaderFlags
	}
	if flags&gzipFlagExtra != 0 {
		xlen, err := d.readFull(2)
		if err != nil {
			return err
		}
		header.Write(xlen)
		extra, err := d.readFull(int(binary.LittleEndian.Uint16(xlen)))
		if err != nil {
			return err
		}
		header.Write(extra)
	}
	for _, flag := range []byte{gzipFlagName, gzipFlagComment} {
		if flags&flag == 0 {
			continue
		}
		for {
			b, err := d.readByte()
			if err != nil {
				return err
			}
			header.Write([]byte{b})
			if b == 0 {
				break
			}
		}
	}
	if flags&gzipFlagHcrc != 0 {
		hcrc, err := d.readFull(2)
		if err != nil {
			return err
		}
		if binary.LittleEndian.Uint16(hcrc) != uint16(header.Sum32()) {
			return errHeaderCrc
		}
	}

	sum := crc32.NewIEEE()
	size := &countingHash{Hash32: sum}
	if err := d.deflate(nil, size); err != nil {
		return err
	}
	trailer, err := d.readFull(8)
	if err != nil {
		return err
	}
	if binary.LittleEndian.Uint32(trailer) != sum.Sum32() {
		return errDataCheck
	}
	if binary.LittleEndian.Uint32(trailer[4:]) != size.n {
		return errLengthCheck
	}
	return nil
}

// countingHash also counts the bytes, for gzip's ISIZE
type countingHash struct {
	hash.Hash32
	n uint32
}

func (c *countingHash) Write(p []byte) (int, error) {
	c.n += uint32(len(p))
	return c.Hash32.Write(p)
}

// deflate decodes raw deflate data into out, sum (when not nil) sees every
// output byte
func (d *decoding) deflate(dict []byte, sum io.Writer) error {
	fr := flate.NewReaderDict(d.in, dict)
	emit := func(p []byte) error {
		if sum != nil {
			sum.Write(p)
		}
		_, err := d.out.Write(p)
		return err
	}

	// a stream input hands out the decoded bytes before it waits: a block
	// ended by a partial flush is complete for the page
	var emitErr error
	if pf, ok := d.in.(pendingFlusher); ok {
		pf.onWait(func() {
			if p := fr.(pender).Pending(); len(p) > 0 && emitErr == nil {
				emitErr = emit(p)
			}
		})
		defer pf.onWait(nil)
	}

	if d.buf == nil {
		d.buf = make([]byte, 32<<10)
	}
	for {
		n, err := fr.Read(d.buf)
		if emitErr != nil {
			return emitErr
		}
		if n > 0 {
			if err := emit(d.buf[:n]); err != nil {
				return err
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return flateError(err)
		}
	}
}

func flateError(err error) error {
	var corrupt flate.CorruptInputError
	switch {
	case errors.As(err, &corrupt):
		return errInvalidData(err.Error())
	case err == io.ErrUnexpectedEOF:
		return errUnexpectedEnd
	}
	return err
}

// brotli decodes one brotli stream; what follows it is ignored, as in Node
func (d *decoding) brotli() error {
	br := brotli.NewReader(d.in)
	if d.buf == nil {
		d.buf = make([]byte, 32<<10)
	}
	for {
		n, err := br.Read(d.buf)
		if n > 0 {
			if _, err := d.out.Write(d.buf[:n]); err != nil {
				return err
			}
		}
		switch {
		case err == nil:
			continue
		case err == io.EOF:
			return nil
		case err == io.ErrUnexpectedEOF:
			return errUnexpectedEnd
		}
		message := err.Error()
		if message == "brotli: excessive input" {
			return nil
		}
		if name, ok := strings.CutPrefix(message, "brotli: "); ok {
			if _, known := brotliErrors[name]; known {
				return brotliError(name)
			}
		}
		return err
	}
}

// decompressAll is the one-shot decompression. With a finishFlush other
// than Z_FINISH, a truncated input gives what it decodes, without error.
func decompressAll(f format, o options, dict []byte, data []byte) ([]byte, error) {
	out := newOutput(o.MaxOutputLength, len(data)*4+64)
	err := decode(f, o, dict, bytes.NewReader(data), out)
	if err == errUnexpectedEnd && !isFinish(f, o.FinishFlush) {
		err = nil
	}
	if err != nil {
		return nil, outputError(err)
	}
	return out.Bytes(), nil
}
