//go:build windows

package fs

import (
	"os"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

func getStatTimes(p string, fi os.FileInfo) (atime, mtime, ctime, birthtime int64) {
	mtime = fi.ModTime().UnixNano()
	atime = mtime
	ctime = mtime
	birthtime = mtime

	if sys, ok := fi.Sys().(*syscall.Win32FileAttributeData); ok {
		atime = sys.LastAccessTime.Nanoseconds()
		mtime = sys.LastWriteTime.Nanoseconds()
		ctime = sys.LastWriteTime.Nanoseconds()
		birthtime = sys.CreationTime.Nanoseconds()
	}
	// the change time is not in the attribute data: libuv (Node's ctime)
	// reads it from FILE_BASIC_INFO
	if change, ok := changeTime(p); ok {
		ctime = change
	}
	return
}

// 100-nanosecond intervals between 1601-01-01 and 1970-01-01
const windowsToUnixEpoch = 116444736000000000

// FILE_BASIC_INFO (not in x/sys/windows); times in 100 ns since 1601
type fileBasicInfo struct {
	CreationTime   int64
	LastAccessTime int64
	LastWriteTime  int64
	ChangeTime     int64
	FileAttributes uint32
	_              uint32
}

func changeTime(p string) (int64, bool) {
	path, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return 0, false
	}
	handle, err := windows.CreateFile(
		path,
		windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		// needed to open a directory
		windows.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
	if err != nil {
		return 0, false
	}
	defer windows.CloseHandle(handle)
	var info fileBasicInfo
	err = windows.GetFileInformationByHandleEx(
		handle,
		windows.FileBasicInfo,
		(*byte)(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	)
	if err != nil || info.ChangeTime == 0 {
		return 0, false
	}
	return (info.ChangeTime - windowsToUnixEpoch) * 100, true
}
