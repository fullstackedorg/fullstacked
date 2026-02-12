package path

import (
	"errors"
	"fullstackedorg/fullstacked/types"
	goPath "path"
	"path/filepath"
	"strings"
)

type PathFn = uint8

const (
	Join      PathFn = 0
	Resolve   PathFn = 1
	Normalize PathFn = 2
	Relative  PathFn = 3
	Parse     PathFn = 4
)

type ParsedPath struct {
	Dir  string `json:"dir"`
	Root string `json:"root"`
	Base string `json:"base"`
	Name string `json:"name"`
	Ext  string `json:"ext"`
}

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Join:
		response.Type = types.CoreResponseData
		response.Data = goPath.Join(DataToStringSlice(data...)...)
		return nil
	case Resolve:
		response.Type = types.CoreResponseData
		strSlice := []string{
			"/",
		}
		strSlice = append(strSlice, DataToStringSlice(data...)...)
		response.Data = goPath.Clean(goPath.Join(strSlice...))
		return nil
	case Normalize:
		response.Type = types.CoreResponseData
		response.Data = goPath.Clean(data[0].Data.(string))
		return nil
	case Relative:
		str, err := filepath.Rel(data[0].Data.(string), data[1].Data.(string))
		if err != nil {
			return err
		}
		response.Type = types.CoreResponseData
		response.Data = str
		return nil
	case Parse:
		response.Type = types.CoreResponseData
		response.Data = ParsePath(data[0].Data.(string))
		return nil
	}
	return errors.New("unkown path function")
}

func ResolveWithContext(ctx *types.Context, paths ...string) string {
	var baseDir string
	if ctx != nil {
		baseDir = ctx.Directories.Root
	}

	strSlice := []string{
		baseDir,
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

func ParsePath(path string) ParsedPath {
	path = strings.TrimRight(path, "/")

	parsed := ParsedPath{
		Root: "",
		Dir:  "",
	}
	parsed.Base = goPath.Base(path)
	if len(path) > len(parsed.Base) {
		parsed.Dir = path[:len(path)-len(parsed.Base)-1]
	}
	parsed.Ext = goPath.Ext(path)
	parsed.Name = strings.TrimSuffix(parsed.Base, parsed.Ext)

	if goPath.IsAbs(path) {
		parsed.Root = "/"
	}
	return parsed
}
