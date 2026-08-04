//go:build windows

package fs

import (
	"os"
	"syscall"
)

func getStatTimes(fi os.FileInfo) (atime, mtime, ctime, birthtime int64) {
	mtime = fi.ModTime().UnixNano()
	atime = mtime
	ctime = mtime
	birthtime = mtime

	if sys, ok := fi.Sys().(*syscall.Win32FileAttributeData); ok {
		atime = sys.LastAccessTime.Nanoseconds()
		mtime = sys.LastWriteTime.Nanoseconds()
		ctime = sys.CreationTime.Nanoseconds()
		birthtime = sys.CreationTime.Nanoseconds()
	}
	return
}
