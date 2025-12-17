package bundle

import (
	"errors"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/types"
	"path"
	"runtime/debug"
	"strings"

	esbuild "github.com/evanw/esbuild/pkg/api"
)

type BundleFn = uint8

const (
	EsbuildVersion BundleFn = 0
	Bundle         BundleFn = 1
)

func Switch(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case EsbuildVersion:
		response.Type = types.CoreResponseData
		response.Data = EsbuildVersionFn()
		return nil
	case Bundle:
		entryPoints := []string{}
		for _, f := range data {
			entryPoints = append(entryPoints, f.Data.(string))
		}
		response.Type = types.CoreResponseData
		response.Data = BundleFnApply(entryPoints)
		return nil
	}

	return errors.New("unknown bundle function")
}

func EsbuildVersionFn() string {
	bi, _ := debug.ReadBuildInfo()

	for _, dep := range bi.Deps {
		if strings.HasSuffix(dep.Path, "esbuild") {
			return dep.Version
		}
	}

	return ""
}

type EsbuildErrorsAndWarning struct {
	Errors   []esbuild.Message
	Warnings []esbuild.Message
}

func BundleFnApply(entryPoints []string) EsbuildErrorsAndWarning {
	entryPointsAdvanced := []esbuild.EntryPoint{}

	for _, f := range entryPoints {
		dir := path.Dir(f)
		name := path.Base(f)
		entryPointsAdvanced = append(entryPointsAdvanced, esbuild.EntryPoint{
			InputPath:  f,
			OutputPath: path.Join(dir, "_"+name),
		})
	}

	result := esbuild.Build(esbuild.BuildOptions{
		EntryPointsAdvanced: entryPointsAdvanced,
		Format:              esbuild.FormatESModule,
		Bundle:              true,
		Sourcemap:           esbuild.SourceMapNone,
		Outdir:              ".",
		Write:               false,
		NodePaths: []string{
			"./lib",
		},
	})

	if len(result.Errors) == 0 {
		for _, f := range result.OutputFiles {
			fs.WrtieFile(f.Path, f.Contents)
		}
	}

	errorsAndWarnings := EsbuildErrorsAndWarning{
		Errors:   result.Errors,
		Warnings: result.Warnings,
	}

	return errorsAndWarnings
}
