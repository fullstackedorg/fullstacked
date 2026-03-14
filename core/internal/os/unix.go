//go:build !WIN
// +build !WIN

package os

import (
	"golang.org/x/sys/unix"
)

func uname() (UnameInfo, error) {
	uname := unix.Utsname{}
	err := unix.Uname(&uname)

	if err != nil {
		return UnameInfo{}, err
	}

	return UnameInfo{
		Sysname:  int8ToStr(uname.Sysname[:]),
		Nodename: int8ToStr(uname.Nodename[:]),
		Release:  int8ToStr(uname.Release[:]),
		Version:  int8ToStr(uname.Version[:]),
		Machine:  int8ToStr(uname.Machine[:]),
	}, nil
}
