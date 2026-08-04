//go:build linux || android

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
		atime = int64(sys.Atim.Sec)*1000000000 + int64(sys.Atim.Nsec)
		mtime = int64(sys.Mtim.Sec)*1000000000 + int64(sys.Mtim.Nsec)
		ctime = int64(sys.Ctim.Sec)*1000000000 + int64(sys.Ctim.Nsec)
		birthtime = ctime
	}
	return
}
