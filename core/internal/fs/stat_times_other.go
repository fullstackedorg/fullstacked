//go:build !darwin && !linux && !android && !windows

package fs

import "os"

func getStatTimes(p string, fi os.FileInfo) (atime, mtime, ctime, birthtime int64) {
	mtime = fi.ModTime().UnixNano()
	return mtime, mtime, mtime, mtime
}
