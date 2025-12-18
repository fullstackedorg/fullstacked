package os

import (
	"errors"
	"fullstackedorg/fullstacked/types"
	"runtime"
)

type OsFn = uint8

const (
	Platform OsFn = 0
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
	}

	return errors.New("unknown os function")
}
