package flate

// From compress/flate's deflate.go and huffman_code.go, used by inflate.go
const (
	maxMatchOffset = 1 << 15 // the largest match offset
	endBlockMarker = 256
)

// Pending returns the bytes decoded so far that Read has not returned yet
// (compress/flate keeps them until the block ends or the window fills).
// It may be called from the reader's ReadByte or Read, on the goroutine that
// called Read: they run between symbols, when the window is consistent.
// What it returns is taken: Read will not return it again.
func (f *decompressor) Pending() []byte {
	return f.dict.readFlush()
}
