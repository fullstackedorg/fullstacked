package path

import (
	"errors"
	"fullstackedorg/fullstacked/types"
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
		response.Data = filepath.Join(DataToStringSlice(data...)...)
		return nil
	case Resolve:
		response.Type = types.CoreResponseData
		strSlice := []string{
			"/",
		}
		strSlice = append(strSlice, DataToStringSlice(data...)...)
		response.Data = filepath.Clean(filepath.Join(strSlice...))
		return nil
	case Normalize:
		response.Type = types.CoreResponseData
		response.Data = filepath.Clean(data[0].Data.(string))
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

func RelativeToRoot(ctx *types.Context, path string) string {
	str, err := filepath.Rel(ctx.Directories.Root, path)
	if err != nil {
		return ""
	}
	return str
}

func RelativeToCwd(ctx *types.Context, path string) string {
	relativeToRoot := RelativeToRoot(ctx, path)
	if ctx == nil || ctx.Cwd == "" {
		return relativeToRoot
	}

	virtualAbsPath := filepath.Join("/", relativeToRoot)
	virtualAbsPath = filepath.Clean(virtualAbsPath)
	cwd := filepath.Clean(ctx.Cwd)

	if !strings.HasPrefix(cwd, "/") && !strings.HasPrefix(cwd, "\\") {
		cwd = "/" + cwd
	}
	cwd = filepath.ToSlash(cwd)
	virtualAbsPath = filepath.ToSlash(virtualAbsPath)

	str, err := filepath.Rel(cwd, virtualAbsPath)
	if err != nil {
		return relativeToRoot
	}
	return str
}

func ResolveWithContext(ctx *types.Context, paths ...string) string {
	var baseDir string
	var rootDir string
	if ctx != nil {
		if strings.HasPrefix(paths[0], "build:") {
			baseDir = ctx.Directories.Build
			rootDir = ctx.Directories.Build
			paths[0] = strings.TrimPrefix(paths[0], "build:")
		} else {
			rootDir = ctx.Directories.Root
			isAbs := filepath.IsAbs(paths[0]) || strings.HasPrefix(paths[0], "/") || strings.HasPrefix(paths[0], "\\")
			if isAbs {
				baseDir = ctx.Directories.Root
			} else {
				baseDir = filepath.Join(ctx.Directories.Root, ctx.Cwd)
			}
		}
	}

	strSlice := []string{
		baseDir,
	}
	strSlice = append(strSlice, paths...)
	resolved := filepath.Clean(filepath.Join(strSlice...))

	if ctx != nil && rootDir != "" {
		rel, err := filepath.Rel(rootDir, resolved)
		if err != nil || strings.HasPrefix(rel, "..") {
			return rootDir
		}
	}

	return resolved
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
	parsed.Base = filepath.Base(path)
	if len(path) > len(parsed.Base) {
		parsed.Dir = path[:len(path)-len(parsed.Base)-1]
	}
	parsed.Ext = filepath.Ext(path)
	parsed.Name = strings.TrimSuffix(parsed.Base, parsed.Ext)

	if filepath.IsAbs(path) || strings.HasPrefix(path, "/") {
		parsed.Root = "/"
	}
	return parsed
}
