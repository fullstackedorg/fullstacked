//go:build darwin

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

	if sys, ok := fi.Sys().(*syscall.Stat_t); ok {
		atime = int64(sys.Atimespec.Sec)*1000000000 + int64(sys.Atimespec.Nsec)
		mtime = int64(sys.Mtimespec.Sec)*1000000000 + int64(sys.Mtimespec.Nsec)
		ctime = int64(sys.Ctimespec.Sec)*1000000000 + int64(sys.Ctimespec.Nsec)
		birthtime = int64(sys.Birthtimespec.Sec)*1000000000 + int64(sys.Birthtimespec.Nsec)
	}
	return
}
