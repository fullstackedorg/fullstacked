package os

import (
	"encoding/binary"
	"errors"
	"fullstackedorg/fullstacked/types"
	"runtime"

	"golang.org/x/sys/unix"
)

type OsFn = uint8

const (
	Platform  OsFn = 0
	Endieness OsFn = 1
	Uname     OsFn = 2
)

func Switch(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Platform:
		response.Type = types.CoreResponseData
		response.Data = runtime.GOOS
		return nil
	case Endieness:
		response.Type = types.CoreResponseData
		response.Data = endieness()
		return nil
	case Uname:
		unameInfo, err := uname()
		if err != nil {
			return err
		}
		response.Type = types.CoreResponseData
		response.Data = unameInfo
		return nil
	}

	return errors.New("unknown os function")
}

// https://stackoverflow.com/a/78297210
func endieness() string {
	little := binary.NativeEndian.Uint16([]byte{0x12, 0x34}) == uint16(0x3412)
	if little {
		return "LE"
	}
	return "BE"
}

func int8ToStr(arr []byte) string {
	b := make([]byte, 0, len(arr))
	for _, v := range arr {
		if v == 0x00 {
			break
		}
		b = append(b, byte(v))
	}
	return string(b)
}

type UnameInfo struct {
	Sysname  string `json:"sysname"`
	Nodename string `json:"nodename"`
	Release  string `json:"release"`
	Version  string `json:"version"`
	Machine  string `json:"machine"`
}

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
