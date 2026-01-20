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

var libModules = map[string]string{
	"buffer":          "/lib/buffer/index.ts",
	"child_process":   "/lib/unavailable/index.ts",
	"crypto":          "/lib/crypto/index.js",
	"dns":             "/lib/dns/index.js",
	"events":          "/lib/events/index.js",
	"fetch":           "/lib/fetch/index.ts",
	"fs":              "/lib/fs/index.ts",
	"fs/promises":     "/lib/fs/promises.ts",
	"net":             "/lib/net/index.ts",
	"os":              "/lib/os/index.ts",
	"path":            "/lib/path/index.ts",
	"process":         "/lib/process/index.ts",
	"stream":          "/lib/stream/index.js",
	"string_decoder":  "/lib/string_decoder/index.js",
	"timers":          "/lib/timers/index.ts",
	"timers/promises": "/lib/timers/promises.ts",
	"tls":             "/lib/unavailable/index.ts",
	"url":             "/lib/url/index.ts",
	"util":            "/lib/util/index.js",
	"zlib":            "/lib/zlib/index.js",

	"test": "/lib/test/index.ts",
}

// https://github.com/evanw/esbuild/blob/main/pkg/api/api_impl.go#L502
var BundleExtensions = []string{".tsx", ".ts", ".jsx", ".js"}

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

var platformBridge = map[PlatformBundle]string{
	Node: "/lib/bridge/platform/node.ts",
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
						Path := path.Join(args.ResolveDir, args.Path)
						Errors := []esbuild.Message{}
						if Path == "/lib/bridge/platform/index.ts" {
							bridge, hasPlatform := platformBridge[platform]
							if !hasPlatform {
								Errors = append(Errors, esbuild.Message{
									Notes: []esbuild.Note{
										{
											Text: "unknown platform bridge",
										},
									},
								})
							}
							Path = bridge
						}
						return esbuild.OnResolveResult{
							Path:      Path,
							Namespace: "lib",
							Errors:    Errors,
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
			fs.WriteFileFn(f.Path, f.Contents)
		}
	}

	errorsAndWarnings := EsbuildErrorsAndWarning{
		Errors:   result.Errors,
		Warnings: result.Warnings,
	}

	return errorsAndWarnings
}
