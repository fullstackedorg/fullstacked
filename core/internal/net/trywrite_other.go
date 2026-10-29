//go:build !unix

package net

import "net"

// tryWrite writes nothing, every write goes to the goroutine of the stream
func tryWrite(socket net.Conn, data []byte) (int, error) {
	return 0, nil
}
