//go:build WIN
// +build WIN

package os

import (
	"fmt"
	"log"

	"golang.org/x/sys/windows/registry"
)

func uname() (UnameInfo, error) {
	return UnameInfo{
		Sysname:  "Windows_NT",
		Nodename: "",
		Release:  release(),
		Version:  "",
		Machine:  "",
	}, nil
}

func release() string {
	key, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion`, registry.QUERY_VALUE)
	if err != nil {
		log.Fatal(err)
	}
	defer key.Close()

	majorVersion, _, err := key.GetIntegerValue("CurrentMajorVersionNumber")
	if err != nil {
		// Fallback for older Windows versions that might not have this key
		majorVersion, _, err = key.GetIntegerValue("MajorVersion")
		if err != nil {
			log.Fatal(err)
		}
	}

	minorVersion, _, err := key.GetIntegerValue("CurrentMinorVersionNumber")
	if err != nil {
		// Fallback for older Windows versions
		minorVersion, _, err = key.GetIntegerValue("MinorVersion")
		if err != nil {
			log.Fatal(err)
		}
	}

	buildNumber, _, err := key.GetStringValue("CurrentBuildNumber")
	if err != nil {
		log.Fatal(err)
	}

	return fmt.Sprintf("%d.%d.%s", majorVersion, minorVersion, buildNumber)
}
