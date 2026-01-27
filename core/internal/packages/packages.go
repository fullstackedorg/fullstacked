package packages

import (
	"errors"
	"fullstackedorg/fullstacked/types"
)

type PackagesFn = uint8

const (
	Install   PackagesFn = 0
	Uninstall PackagesFn = 1
)

func Switch(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {

	}

	return errors.New("unknown git function")
}
