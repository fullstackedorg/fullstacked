package fs

import (
	"errors"
	"fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/types"
	"os"
)

type FsFn = uint8

const (
	Exists   FsFn = 0
	ReadFile FsFn = 1
)

func Switch(
	ctx *types.CoreCallContext,
	fn FsFn,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch fn {
	case Exists:
		filePath := path.ResolveWithContext(ctx, data[0].Data.(string))
		response.Type = types.CoreResponseData
		response.Data = ExistsFn(filePath)
		return nil
	case ReadFile:
		response.Type = types.CoreResponseData

		return nil
	}

	return errors.New("unkown fs function")
}

func ExistsFn(p string) bool {
	_, err := os.Stat(p)
	if err == nil {
		return true
	}
	return false
}

type ReadFileOpts struct {
	Encoding string `json:"encoding"`
}

func ReadFileFn(p string, opts ReadFileOpts) {
}
