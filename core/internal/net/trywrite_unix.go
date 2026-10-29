//go:build unix

package net

import (
	"errors"
	"net"
	"syscall"
)

// tryWrite writes what the socket takes now, without waiting: one write
// on the non-blocking descriptor of the poller. Returns the bytes written.
func tryWrite(socket net.Conn, data []byte) (int, error) {
	conn, ok := socket.(syscall.Conn)
	if !ok {
		return 0, nil
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, err
	}

	n := 0
	var writeErr error
	err = raw.Write(func(fd uintptr) bool {
		n, writeErr = syscall.Write(int(fd), data)
		// done either way, never wait for the socket to be writable
		return true
	})
	if err != nil {
		return 0, err
	}
	if errors.Is(writeErr, syscall.EAGAIN) || errors.Is(writeErr, syscall.EINTR) {
		return 0, nil
	}
	if writeErr != nil {
		return 0, writeErr
	}
	return max(n, 0), nil
}
