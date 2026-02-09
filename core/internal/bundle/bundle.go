package bundle

import (
	"embed"
	"errors"
	"fullstackedorg/fullstacked/internal/fs"
	fspath "fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/types"
	"path"
	"runtime/debug"
	"strings"

	esbuild "github.com/evanw/esbuild/pkg/api"
)

//go:embed lib
var lib embed.FS

var libModules = map[string]string{
	"assert":              "/lib/assert/index.js",
	"async_hooks":         "/lib/unavailable/index.ts",
	"buffer":              "/lib/buffer/index.ts",
	"bundle":              "/lib/bundle/index.ts",
	"child_process":       "/lib/unavailable/index.ts",
	"console":             "/lib/console/index.ts",
	"crypto":              "/lib/crypto/index.js",
	"diagnostics_channel": "/lib/diagnostics_channel/index.js",
	"dns":                 "/lib/dns/index.js",
	"events":              "/lib/events/index.js",
	"fetch":               "/lib/fetch/index.ts",
	"fs":                  "/lib/fs/index.ts",
	"fs/promises":         "/lib/fs/promises.ts",
	"fullstacked":         "/lib/fullstacked/index.ts",
	"git":                 "/lib/git/index.ts",
	"http":                "/lib/unavailable/index.ts",
	"https":               "/lib/unavailable/index.ts",
	"module":              "/lib/unavailable/index.ts",
	"net":                 "/lib/net/index.ts",
	"os":                  "/lib/os/index.ts",
	"packages":            "/lib/packages/index.ts",
	"path":                "/lib/path/index.ts",
	"perf_hooks":          "/lib/unavailable/index.ts",
	"process":             "/lib/process/index.ts",
	"querystring":         "/lib/querystring/index.ts",
	"run":                 "/lib/run/index.ts",
	"stream":              "/lib/stream/index.js",
	"string_decoder":      "/lib/string_decoder/index.js",
	"sqlite":              "/lib/unavailable/index.js",
	"timers":              "/lib/timers/index.ts",
	"timers/promises":     "/lib/timers/promises.ts",
	"tls":                 "/lib/unavailable/index.ts",
	"tty":                 "/lib/tty/index.ts",
	"url":                 "/lib/url/index.ts",
	"util":                "/lib/util/index.js",
	"util/types":          "/lib/util/types/index.js",
	"vm":                  "/lib/unavailable/index.ts",
	"v8":                  "/lib/unavailable/index.ts",
	"worker_threads":      "/lib/unavailable/index.ts",
	"zlib":                "/lib/zlib/index.js",

	"test": "/lib/test/index.ts",
}

// https://github.com/evanw/esbuild/blob/main/pkg/api/api_impl.go#L502
var BundleExtensions = []string{".tsx", ".ts", ".jsx", ".js"}

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
			entryPoints = append(entryPoints, fspath.ResolveWithContext(ctx, f.Data.(string)))
		}

		if len(entryPoints) == 0 {
			entryPoint := findEntryPoint(ctx.BaseDirectory)
			if entryPoint == "" {
				return errors.New("no entry point found")
			}
			entryPoints = append(entryPoints, entryPoint)
		}

		response.Type = types.CoreResponseData
		response.Data = BundleFnApply(entryPoints)
		return nil
	}

	return errors.New("unknown bundle function")
}

func findEntryPoint(dir string) string {
	for _, f := range BundleExtensions {
		if fs.ExistsFn(path.Join(dir, "index"+f)) {
			return path.Join(dir, "index"+f)
		}
	}

	return ""
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
		exists := fs.ExistsFn(f)
		if !exists {
			return EsbuildErrorsAndWarning{
				Errors: []esbuild.Message{
					{
						Text: "entry point not found: " + f,
					},
				},
			}
		}

		stats, err := fs.StatsFn(f)
		if err != nil {
			return EsbuildErrorsAndWarning{
				Errors: []esbuild.Message{
					{
						Text: "failed to stats: " + f,
					},
				},
			}
		}

		if stats.IsDir {
			foundEntrypoint := findEntryPoint(f)
			if foundEntrypoint == "" {
				return EsbuildErrorsAndWarning{
					Errors: []esbuild.Message{
						{
							Text: "no entry point found in directory: " + f,
						},
					},
				}
			}
			f = foundEntrypoint
		}

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
						if strings.HasSuffix(args.Path, ".node") {
							return esbuild.OnResolveResult{
								External: true,
							}, nil
						}

						args.Path = strings.TrimPrefix(args.Path, "node:")

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
						return esbuild.OnResolveResult{
							Path:      Path,
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
			fs.WriteFileFn(f.Path, f.Contents)
		}
	}

	errorsAndWarnings := EsbuildErrorsAndWarning{
		Errors:   result.Errors,
		Warnings: result.Warnings,
	}

	return errorsAndWarnings
}
