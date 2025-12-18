package bundle

import (
	"embed"
	"errors"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/types"
	"path"
	"runtime/debug"
	"strings"

	esbuild "github.com/evanw/esbuild/pkg/api"
)

//go:embed lib
var lib embed.FS

type PlatformBundle = float64

const (
	Node     = 0
	Apple    = 1
	Android  = 2
	Windows  = 3
	Wasm     = 4
	LinuxGTK = 5
	LinuxQt  = 6
	Electron = 7
)

var libModules = map[string]string{
	"fs": "/lib/fs/index.ts",
}

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
		for _, f := range data[1:] {
			entryPoints = append(entryPoints, f.Data.(string))
		}
		response.Type = types.CoreResponseData
		response.Data = BundleFnApply(data[0].Data.(float64), entryPoints)
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

func BundleFnApply(platform PlatformBundle, entryPoints []string) EsbuildErrorsAndWarning {
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
		Plugins: []esbuild.Plugin{
			{
				Name: "lib",
				Setup: func(build esbuild.PluginBuild) {

					// catch lib module entry
					build.OnResolve(esbuild.OnResolveOptions{Filter: ".*"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
						libModulePath, isLibModule := libModules[args.Path]

						if !isLibModule {
							return esbuild.OnResolveResult{}, nil
						}

						return esbuild.OnResolveResult{
							Namespace: "lib",
							Path:      libModulePath,
						}, nil
					})

					// resolve relative import in lib modules
					build.OnResolve(esbuild.OnResolveOptions{Filter: ".*", Namespace: "lib"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
						return esbuild.OnResolveResult{
							Path:      path.Join(args.ResolveDir, args.Path),
							Namespace: "lib",
						}, nil
					})

					// load files from embed
					build.OnLoad(esbuild.OnLoadOptions{Namespace: "lib", Filter: ".*"}, func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
						contents, _ := lib.ReadFile(args.Path[1:])
						str := string(contents)
						return esbuild.OnLoadResult{
							Loader:     esbuild.LoaderTS,
							Contents:   &str,
							ResolveDir: path.Dir(args.Path),
						}, nil
					})
				},
			},
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
