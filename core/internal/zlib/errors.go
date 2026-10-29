package zlib

import "strconv"

// nodeError travels to the JS side as "<Class>|<code>|<errno>|<message>":
// Node's zlib errors carry the zlib or brotli return value as `errno` next
// to `code`, the errors of Node's JS layer (ERR_BUFFER_TOO_LARGE) have no
// errno and leave it empty
type nodeError struct {
	class   string
	code    string
	errno   string
	message string
}

func (e *nodeError) Error() string {
	return e.class + "|" + e.code + "|" + e.errno + "|" + e.message
}

// zlibError is what Node's zlib binding reports: an Error with the name of
// the zlib return code as code and its value as errno
func zlibError(code string, errno int, message string) error {
	return &nodeError{"Error", code, strconv.Itoa(errno), message}
}

// zlib.h return codes
const (
	zNeedDict  = 2
	zDataError = -3
	zBufError  = -5
)

var (
	errUnexpectedEnd   = zlibError("Z_BUF_ERROR", zBufError, "unexpected end of file")
	errHeaderCheck     = zlibError("Z_DATA_ERROR", zDataError, "incorrect header check")
	errUnknownMethod   = zlibError("Z_DATA_ERROR", zDataError, "unknown compression method")
	errWindowSize      = zlibError("Z_DATA_ERROR", zDataError, "invalid window size")
	errHeaderFlags     = zlibError("Z_DATA_ERROR", zDataError, "unknown header flags set")
	errHeaderCrc       = zlibError("Z_DATA_ERROR", zDataError, "header crc mismatch")
	errDataCheck       = zlibError("Z_DATA_ERROR", zDataError, "incorrect data check")
	errLengthCheck     = zlibError("Z_DATA_ERROR", zDataError, "incorrect length check")
	errMissingDict     = zlibError("Z_NEED_DICT", zNeedDict, "Missing dictionary")
	errBadDict         = zlibError("Z_NEED_DICT", zNeedDict, "Bad dictionary")
	errInvalidHandle   = &nodeError{"Error", "ERR_ZLIB_INITIALIZATION_FAILED", "", "Invalid zlib handle"}
	errTooManyHandles  = &nodeError{"Error", "ERR_ZLIB_INITIALIZATION_FAILED", "", "too many zlib streams"}
	errContextEnded    = &nodeError{"Error", "ERR_ZLIB_INITIALIZATION_FAILED", "", "context ended"}
	errUnknownFormat   = &nodeError{"TypeError", "ERR_INVALID_ARG_VALUE", "", "unknown zlib format"}
	errOperationFailed = &nodeError{"Error", "ERR_ZLIB_INITIALIZATION_FAILED", "", "zlib operation failed"}
)

// zlib names the corrupt deflate data it finds ("invalid distance too far
// back", "invalid code lengths set"...); compress/flate only reports where,
// so the message is generic and code and errno are zlib's
func errInvalidData(detail string) error {
	return zlibError("Z_DATA_ERROR", zDataError, "invalid deflate data ("+detail+")")
}

// errTooLarge is Node's ERR_BUFFER_TOO_LARGE, for maxOutputLength
func errTooLarge(max int) error {
	return &nodeError{"RangeError", "ERR_BUFFER_TOO_LARGE", "", "Cannot create a Buffer larger than " + strconv.Itoa(max) + " bytes"}
}

// Brotli decoder errors: Node's code is "ERR_" and the name of the error in
// the C library (BrotliDecoderErrorString), its errno the error's value. The
// Go port has the same values but names them without the prefix.
func brotliError(name string) error {
	errno, ok := brotliErrors[name]
	if !ok {
		errno = -31
		name = "UNREACHABLE"
	}
	prefix := "_ERROR_FORMAT_"
	switch {
	case errno <= -21 && errno >= -30:
		prefix = "_ERROR_ALLOC_"
	case errno < -16:
		prefix = "_ERROR_"
	}
	return &nodeError{"Error", "ERR_" + prefix + name, strconv.Itoa(errno), "Decompression failed"}
}

var brotliErrors = map[string]int{
	"EXUBERANT_NIBBLE":        -1,
	"RESERVED":                -2,
	"EXUBERANT_META_NIBBLE":   -3,
	"SIMPLE_HUFFMAN_ALPHABET": -4,
	"SIMPLE_HUFFMAN_SAME":     -5,
	"CL_SPACE":                -6,
	"HUFFMAN_SPACE":           -7,
	"CONTEXT_MAP_REPEAT":      -8,
	"BLOCK_LENGTH_1":          -9,
	"BLOCK_LENGTH_2":          -10,
	"TRANSFORM":               -11,
	"DICTIONARY":              -12,
	"WINDOW_BITS":             -13,
	"PADDING_1":               -14,
	"PADDING_2":               -15,
	"DISTANCE":                -16,
	"COMPOUND_DICTIONARY":     -18,
	"DICTIONARY_NOT_SET":      -19,
	"INVALID_ARGUMENTS":       -20,
	"CONTEXT_MODES":           -21,
	"TREE_GROUPS":             -22,
	"CONTEXT_MAP":             -25,
	"RING_BUFFER_1":           -26,
	"RING_BUFFER_2":           -27,
	"BLOCK_TYPE_TREES":        -30,
	"UNREACHABLE":             -31,
}
