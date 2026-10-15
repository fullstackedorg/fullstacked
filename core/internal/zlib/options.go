package zlib

// format is the container around the compressed data
type format int

const (
	formatDeflate    format = iota // zlib: RFC 1950 header and Adler-32
	formatDeflateRaw               // RFC 1951 alone
	formatGzip                     // RFC 1952 members
	formatUnzip                    // decompression of gzip or zlib, by the header
	formatBrotli
)

func parseFormat(name string, compress bool) (format, error) {
	switch name {
	case "deflate":
		return formatDeflate, nil
	case "deflateRaw":
		return formatDeflateRaw, nil
	case "gzip":
		return formatGzip, nil
	case "unzip":
		if !compress {
			return formatUnzip, nil
		}
	case "brotli":
		return formatBrotli, nil
	}
	return 0, errUnknownFormat
}

// Node's zlib constants the core needs
const (
	zNoFlush      = 0
	zPartialFlush = 1
	zSyncFlush    = 2
	zFullFlush    = 3
	zFinish       = 4
	zBlock        = 5

	zDefaultCompression = -1
	zHuffmanOnly        = 2

	brotliOperationProcess = 0
	brotliOperationFlush   = 1
	brotliOperationFinish  = 2
)

// options are what the JS side validated (lib/zlib does Node's range
// checks), defaults applied. memLevel and chunkSize do not reach the core:
// the flate writer has no equivalent.
type options struct {
	Level      int `json:"level"`
	WindowBits int `json:"windowBits"`
	Strategy   int `json:"strategy"`
	// the flush of the last write of a one-shot call (Node's finishFlush)
	FinishFlush int `json:"finishFlush"`
	// 0: no limit
	MaxOutputLength int `json:"maxOutputLength"`

	// brotli encoder: BROTLI_PARAM_QUALITY and BROTLI_PARAM_LGWIN.
	// BROTLI_PARAM_MODE and BROTLI_PARAM_SIZE_HINT are accepted by the JS
	// side and not used: the Go encoder chooses them itself.
	Quality int `json:"quality"`
	LgWin   int `json:"lgwin"`
}

func defaultOptions(f format) options {
	o := options{
		Level:       zDefaultCompression,
		WindowBits:  15,
		FinishFlush: zFinish,
		Quality:     11,
		LgWin:       22,
	}
	if f == formatBrotli {
		o.FinishFlush = brotliOperationFinish
	}
	return o
}

// parseOptions reads the options object in argument i over the defaults of
// the format in argument 0
func parseOptions(a args, i int) (options, error) {
	f, _ := parseFormat(a.str(0), false)
	o := defaultOptions(f)
	if err := a.object(i, &o); err != nil {
		return o, errOperationFailed
	}
	return o, nil
}

// isFinish tells whether a flush value ends the stream: Z_FINISH, or
// BROTLI_OPERATION_FINISH for brotli
func isFinish(f format, flush int) bool {
	if f == formatBrotli {
		return flush == brotliOperationFinish
	}
	return flush == zFinish
}

// isFlush tells whether a flush value asks for the output of everything
// written so far
func isFlush(f format, flush int) bool {
	if f == formatBrotli {
		return flush == brotliOperationFlush
	}
	switch flush {
	case zPartialFlush, zSyncFlush, zFullFlush, zBlock:
		return true
	}
	return false
}
