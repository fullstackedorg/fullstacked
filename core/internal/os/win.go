//go:build WIN
// +build WIN

package os

func uname() (UnameInfo, error) {
	return UnameInfo{
		Sysname:  "Windows",
		Nodename: "",
		Release:  "",
		Version:  "",
		Machine:  "",
	}, nil
}
