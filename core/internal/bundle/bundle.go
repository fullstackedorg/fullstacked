package bundle

import (
	"embed"
	"errors"
	"fullstackedorg/fullstacked/internal/fs"
	fspath "fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"path"
	"runtime/debug"
	"strings"
	"sync"

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
	"constants":           "/lib/constants/index.json",
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
	"worker_threads":      "/lib/worker_threads/index.ts",
	"zlib":                "/lib/zlib/index.js",

	"test": "/lib/test/index.ts",
}

// https://github.com/evanw/esbuild/blob/main/pkg/api/api_impl.go#L502
var BundleExtensions = []string{".tsx", ".ts", ".jsx", ".js"}

type BundleFn = uint8

const (
	EsbuildVersion     BundleFn = 0
	Bundle             BundleFn = 1
	BuilderTailwindCSS BundleFn = 2
	BuilderSASS        BundleFn = 3
)

type TailwindCSSBuilder struct {
	ctx      *types.Context
	streamId uint8
	wg       *sync.WaitGroup
}

// ctx.Id -> builderTailwindCSS
var builderTailwindCSS = make(map[uint8]TailwindCSSBuilder)

func Switch(
	ctx *types.Context,
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
		entryPoint := ctx.Directories.Root
		if len(data) >= 1 {
			entryPoint = fspath.ResolveWithContext(ctx, data[0].Data.(string))
		}

		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				result := BundleFnApply(ctx, entryPoint)
				store.StreamEvent(ctx, streamId, "result", []types.SerializableData{result}, true)
			},
		}
		return nil
	case BuilderTailwindCSS:
		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				builderTailwindCSS[ctx.Id] = TailwindCSSBuilder{
					ctx:      ctx,
					streamId: streamId,
					wg:       &sync.WaitGroup{},
				}
			},
			WriteEvent: func(ctx *types.Context, streamId uint8, event string, data []types.DeserializedData) {
				if event != "build-done" {
					return
				}

				builder, ok := builderTailwindCSS[ctx.Id]
				if !ok {
					return
				}

				builder.wg.Done()
			},
			Close: func(ctx *types.Context, streamId uint8) {
				delete(builderTailwindCSS, ctx.Id)
			},
		}
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

type EsbuildResult struct {
	OutputFiles []string
	Errors      []esbuild.Message
	Warnings    []esbuild.Message
}

var bundleBase = []byte("import \"fullstacked\";\n")

func BundleFnApply(ctx *types.Context, entryPoint string) EsbuildResult {
	exists := fs.ExistsFn(entryPoint)
	if !exists {
		return EsbuildResult{
			Errors: []esbuild.Message{
				{
					Text: "entry point not found",
				},
			},
		}
	}

	stats, err := fs.StatsFn(entryPoint)
	if err != nil {
		return EsbuildResult{
			Errors: []esbuild.Message{
				{
					Text: "failed to stats: " + entryPoint,
				},
			},
		}
	}

	if stats.IsDir {
		foundEntrypoint := findEntryPoint(entryPoint)
		if foundEntrypoint == "" {
			return EsbuildResult{
				Errors: []esbuild.Message{
					{
						Text: "no entry point found in directory: " + entryPoint,
					},
				},
			}
		}
		entryPoint = foundEntrypoint
	}

	contents, err := fs.ReadFileFn(entryPoint)
	if err != nil {
		return EsbuildResult{
			Errors: []esbuild.Message{
				{
					Text: "failed to read file: " + entryPoint,
				},
			},
		}
	}

	contents, err = serialization.MergeBuffers(bundleBase, contents)
	if err != nil {
		return EsbuildResult{
			Errors: []esbuild.Message{
				{
					Text: "failed to merge buffers: " + entryPoint,
				},
			},
		}
	}

	ext := path.Ext(entryPoint)
	loader := esbuild.LoaderJS
	switch ext {
	case ".ts":
		loader = esbuild.LoaderTS
	case ".tsx":
		loader = esbuild.LoaderTSX
	case ".jsx":
		loader = esbuild.LoaderJSX
	}

	// []string
	sources := []types.SerializableData{fspath.RelativeToRoot(ctx, entryPoint)}

	result := esbuild.Build(esbuild.BuildOptions{
		Stdin: &esbuild.StdinOptions{
			Contents:   string(contents),
			Sourcefile: entryPoint,
			ResolveDir: path.Dir(entryPoint),
			Loader:     loader,
		},
		Format:    esbuild.FormatESModule,
		Bundle:    true,
		Sourcemap: esbuild.SourceMapNone,
		Outdir:    ".",
		Write:     false,
		Plugins: []esbuild.Plugin{
			{
				Name: "lib",
				Setup: func(build esbuild.PluginBuild) {
					// catch lib module entry
					build.OnResolve(esbuild.OnResolveOptions{Filter: ".*"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
						// node:fs => fs
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

					build.OnLoad(esbuild.OnLoadOptions{Filter: ".*"}, func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
						if args.Namespace != "lib" && !strings.Contains(args.Path, "node_modules") {
							sources = append(sources, fspath.RelativeToRoot(ctx, args.Path))
						}
						return esbuild.OnLoadResult{}, nil
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
						ext := path.Ext(args.Path)
						loader := esbuild.LoaderJS
						switch ext {
						case ".ts":
							loader = esbuild.LoaderTS
						case ".tsx":
							loader = esbuild.LoaderTSX
						case ".jsx":
							loader = esbuild.LoaderJSX
						case ".json":
							loader = esbuild.LoaderJSON
						}
						return esbuild.OnLoadResult{
							Loader:     loader,
							Contents:   &str,
							ResolveDir: path.Dir(args.Path),
						}, nil
					})
				},
			},
		},
	})

	esbuildResult := EsbuildResult{
		Errors:      result.Errors,
		Warnings:    result.Warnings,
		OutputFiles: []string{},
	}

	if len(result.Errors) == 0 {
		dir := path.Dir(entryPoint)
		entrypointBaseName := path.Base(entryPoint)

		tailwindEntry := fspath.RelativeToRoot(ctx, path.Join(dir, "index.css"))
		tailwindOutput := fspath.RelativeToRoot(ctx, path.Join(dir, "_"+entrypointBaseName+".tailwind.css"))
		tailwindCSSBuild(ctx, tailwindEntry, tailwindOutput, sources)

		for _, f := range result.OutputFiles {
			ext := path.Ext(f.Path)
			f.Path = path.Join(dir, "_"+entrypointBaseName+ext)
			fs.WriteFileFn(f.Path, f.Contents)
			esbuildResult.OutputFiles = append(esbuildResult.OutputFiles, fspath.RelativeToRoot(ctx, f.Path))
		}
	}

	return esbuildResult
}

func tailwindCSSBuild(ctx *types.Context, entry string, outfile string, sources []types.SerializableData) {
	builder, ok := builderTailwindCSS[ctx.Id]
	if !ok {
		return
	}

	data := []types.SerializableData{entry, outfile}
	data = append(data, sources...)

	builder.wg.Add(1)
	store.StreamEvent(ctx, builder.streamId, "build", data, false)
	builder.wg.Wait()
}
