package path

import (
	"errors"
	"fullstackedorg/fullstacked/types"
	goPath "path"
)

type PathFn = uint8

const (
	Join    PathFn = 0
	Resolve PathFn = 1
)

func Switch(
	ctx *types.CoreCallContext,
	fn PathFn,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch fn {
	case Join:
		response.Type = types.CoreResponseData
		response.Data = goPath.Join(DataToStringSlice(data...)...)
		return nil
	case Resolve:
		response.Type = types.CoreResponseData
		response.Data = ResolveWithContext(ctx, DataToStringSlice(data...)...)
		return nil
	}
	return errors.New("unkown path function")
}

func ResolveWithContext(ctx *types.CoreCallContext, paths ...string) string {
	strSlice := []string{
		ctx.BaseDirectory,
	}
	strSlice = append(strSlice, paths...)
	return goPath.Join(strSlice...)
}

func DataToStringSlice(data ...types.DeserializedData) []string {
	strSlice := []string{}
	for _, p := range data {
		strSlice = append(strSlice, p.Data.(string))
	}
	return strSlice
}
