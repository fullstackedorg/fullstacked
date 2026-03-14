package bundle

import (
	"embed"
	"errors"
	"fullstackedorg/fullstacked/internal/fs"
	fspath "fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"os"
	"path"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"

	esbuild "github.com/evanw/esbuild/pkg/api"
)

//go:embed lib
var lib embed.FS

var libModules = map[string]string{
	"assert":               "/lib/assert/index.js",
	"async_hooks":          "/lib/unavailable/index.ts",
	"buffer":               "/lib/buffer/index.ts",
	"bundle":               "/lib/bundle/index.ts",
	"child_process":        "/lib/unavailable/index.ts",
	"console":              "/lib/console/index.ts",
	"constants":            "/lib/constants/index.json",
	"crypto":               "/lib/crypto/index.ts",
	"diagnostics_channel":  "/lib/diagnostics_channel/index.js",
	"dns":                  "/lib/dns/index.js",
	"events":               "/lib/events/index.js",
	"fetch":                "/lib/fetch/index.ts",
	"fs":                   "/lib/fs/index.ts",
	"fs/promises":          "/lib/fs/promises.ts",
	"fullstacked":          "/lib/fullstacked/index.ts",
	"fullstacked/bundle":   "/lib/bundle/index.ts",
	"fullstacked/git":      "/lib/git/index.ts",
	"fullstacked/packages": "/lib/packages/index.ts",
	"fullstacked/run":      "/lib/run/index.ts",
	"fullstacked/sentry":   "/lib/sentry/index.ts",
	"git":                  "/lib/git/index.ts",
	"http":                 "/lib/http/index.ts",
	"https":                "/lib/https/index.ts",
	"module":               "/lib/unavailable/index.ts",
	"net":                  "/lib/net/index.ts",
	"os":                   "/lib/os/index.ts",
	"packages":             "/lib/packages/index.ts",
	"path":                 "/lib/path/index.ts",
	"perf_hooks":           "/lib/unavailable/index.ts",
	"process":              "/lib/process/index.ts",
	"querystring":          "/lib/querystring/index.ts",
	"run":                  "/lib/run/index.ts",
	"sentry":               "/lib/sentry/index.ts",
	"stream":               "/lib/stream/index.js",
	"string_decoder":       "/lib/string_decoder/index.js",
	"sqlite":               "/lib/unavailable/index.js",
	"timers":               "/lib/timers/index.ts",
	"timers/promises":      "/lib/timers/promises.ts",
	"tls":                  "/lib/unavailable/index.ts",
	"tty":                  "/lib/tty/index.ts",
	"url":                  "/lib/url/index.ts",
	"util":                 "/lib/util/index.js",
	"util/types":           "/lib/util/types/index.js",
	"vm":                   "/lib/unavailable/index.ts",
	"v8":                   "/lib/unavailable/index.ts",
	"worker_threads":       "/lib/worker_threads/index.ts",
	"zlib":                 "/lib/zlib/index.ts",

	"test": "/lib/test/index.ts",
}

// https://github.com/evanw/esbuild/blob/main/pkg/api/api_impl.go#L502
var BundleExtensions = []string{".tsx", ".ts", ".jsx", ".js"}

type BundleFn = uint8

const (
	EsbuildVersion     BundleFn = 0
	BundleDir          BundleFn = 1
	BundleFile         BundleFn = 2
	BuilderTailwindCSS BundleFn = 3
	BuilderSASS        BundleFn = 4
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
	case BundleDir:
		entryPoint := ctx.Directories.Root
		if len(data) >= 1 {
			entryPoint = fspath.ResolveWithContext(ctx, data[0].Data.(string))
		}

		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				result := BundleDirFn(ctx, entryPoint)
				store.StreamEvent(ctx, streamId, "result", []types.SerializableData{result}, true)
			},
		}
		return nil
	case BundleFile:
		entryPoint := ctx.Directories.Root
		if len(data) >= 1 {
			entryPoint = fspath.ResolveWithContext(ctx, data[0].Data.(string))
		}

		result := BundleFileFn(ctx, entryPoint)
		response.Type = types.CoreResponseData
		response.Data = result
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

func findEntryPointInDir(dir string) (string, error) {
	for _, f := range BundleExtensions {
		if fs.ExistsFn(path.Join(dir, "index"+f)) {
			return path.Join(dir, "index"+f), nil
		}
	}

	return "", errors.New("no entry point found in directory: " + dir)
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

func prepareBundleStdin(entryPoint string) (esbuild.StdinOptions, error) {
	stdin := esbuild.StdinOptions{}

	// check if passed entry exists
	exists := fs.ExistsFn(entryPoint)
	if !exists {
		return stdin, errors.New("entry point not found")
	}

	// lets gets stats for "isDir"
	stats, err := fs.StatsFn(entryPoint)
	if err != nil {
		return stdin, errors.New("failed to stats: " + entryPoint)
	}

	// is a directory, lets find an entry point
	if stats.IsDir {
		foundEntrypoint, err := findEntryPointInDir(entryPoint)
		if err != nil {
			return stdin, err
		}
		entryPoint = foundEntrypoint
	}

	// read the entry point
	contents, err := fs.ReadFileFn(entryPoint)
	if err != nil {
		return stdin, errors.New("failed to read file: " + entryPoint)
	}

	// merge bundle base
	contents, err = serialization.MergeBuffers(bundleBase, contents)
	if err != nil {
		return stdin, errors.New("failed to merge buffers: " + entryPoint)
	}

	// find the right loader
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

	stdin.Contents = string(contents)
	stdin.Sourcefile = entryPoint
	stdin.ResolveDir = filepath.Dir(entryPoint)
	stdin.Loader = loader

	return stdin, nil
}

func prepareBundleOptions(entryPoint string) (esbuild.BuildOptions, error) {
	// common options
	esbuildBuildOptions := esbuild.BuildOptions{
		Format:    esbuild.FormatESModule,
		Bundle:    true,
		Sourcemap: esbuild.SourceMapNone,
		Write:     false,
		Plugins:   esbuildPluginsLib,
	}

	stdin, err := prepareBundleStdin(entryPoint)
	if err != nil {
		return esbuildBuildOptions, err
	}

	esbuildBuildOptions.Stdin = &stdin

	return esbuildBuildOptions, nil
}

// bundle a directory into a bundled html file
// you can still pass then main entrypoint as param
// ie.  [ . | index.ts ] 	-> /out/index.ts.js
//
//	-> /out/index.ts.css
//	-> /out/index.ts.tailwind.css
//	-> /out/index.html
//	-> /out/image-xyz.png
func BundleDirFn(ctx *types.Context, entryPoint string) EsbuildResult {
	buildOptions, err := prepareBundleOptions(entryPoint)
	if err != nil {
		return EsbuildResult{
			Errors: []esbuild.Message{
				{
					Text: err.Error(),
				},
			},
		}
	}

	// extra loaders for images
	buildOptions.Loader = map[string]esbuild.Loader{
		".png":  esbuild.LoaderFile,
		".jpg":  esbuild.LoaderFile,
		".jpeg": esbuild.LoaderFile,
		".gif":  esbuild.LoaderFile,
		".svg":  esbuild.LoaderFile,
	}

	// setup outdir
	buildOptions.Outdir = filepath.Join(filepath.Dir(buildOptions.Stdin.Sourcefile), "out")

	// prepare tailwind
	tailwindcssEntry := ""
	sources := []string{buildOptions.Stdin.Sourcefile}
	buildOptions.Plugins = append(buildOptions.Plugins, prepareTailwindcssPlugin(&tailwindcssEntry, &sources))

	result := esbuild.Build(buildOptions)

	esbuildResult := EsbuildResult{
		Errors:      result.Errors,
		Warnings:    result.Warnings,
		OutputFiles: []string{}, // relative to ctx root
	}

	// relative to outdir
	htmlAssets := []string{}

	if len(result.Errors) == 0 {
		fs.MkdirFn(buildOptions.Outdir)

		entrypointBaseName := filepath.Base(buildOptions.Stdin.Sourcefile)

		for _, file := range result.OutputFiles {
			if strings.HasPrefix(filepath.Base(file.Path), "stdin") {
				file.Path = filepath.Join(filepath.Dir(file.Path), entrypointBaseName+filepath.Ext(file.Path))
			}
			fs.WriteFileFn(file.Path, file.Contents)

			// relative to build dir
			pathRel, _ := filepath.Rel(buildOptions.Outdir, file.Path)
			htmlAssets = append(htmlAssets, pathRel)

			// relative to ctx root dir
			esbuildResult.OutputFiles = append(esbuildResult.OutputFiles, fspath.RelativeToRoot(ctx, file.Path))
		}

		if tailwindcssEntry != "" {
			tailwindOutput := filepath.Join(buildOptions.Outdir, entrypointBaseName+".tailwind.css")
			err := tailwindCSSBuild(ctx, tailwindcssEntry, tailwindOutput, sources)
			if err == nil {
				// relative to build dir
				pathRel, _ := filepath.Rel(buildOptions.Outdir, tailwindOutput)
				htmlAssets = append(htmlAssets, pathRel)

				// relative to ctx root dir
				esbuildResult.OutputFiles = append(esbuildResult.OutputFiles, fspath.RelativeToRoot(ctx, tailwindOutput))
			}
		}

		// files must be relative to out directory
		html, _ := generateIndexHTML(htmlAssets)
		fs.WriteFileFn(filepath.Join(buildOptions.Outdir, "index.html"), html)
		indexHTMLPathRel := fspath.RelativeToRoot(ctx, path.Join(buildOptions.Outdir, "index.html"))
		esbuildResult.OutputFiles = append(esbuildResult.OutputFiles, indexHTMLPathRel)
	}

	return esbuildResult
}

// bundle a file into a single bundled file
// no css output, no tailwindcss output, no html output, no assets
// ie. index.ts -> index.ts.js
func BundleFileFn(ctx *types.Context, entryPoint string) EsbuildResult {
	buildOptions, err := prepareBundleOptions(entryPoint)
	if err != nil {
		return EsbuildResult{
			Errors: []esbuild.Message{
				{
					Text: err.Error(),
				},
			},
		}
	}

	buildOptions.Outfile = buildOptions.Stdin.Sourcefile + ".js"

	result := esbuild.Build(buildOptions)

	esbuildResult := EsbuildResult{
		Errors:      result.Errors,
		Warnings:    result.Warnings,
		OutputFiles: []string{},
	}

	if len(result.Errors) == 0 {
		for i := range result.OutputFiles {
			fs.WriteFileFn(result.OutputFiles[i].Path, result.OutputFiles[i].Contents)
			pathRel := fspath.RelativeToRoot(ctx, result.OutputFiles[i].Path)
			esbuildResult.OutputFiles = append(esbuildResult.OutputFiles, pathRel)
		}
	}

	return esbuildResult
}

var esbuildPluginsLib = []esbuild.Plugin{
	{
		Name: "lib",
		Setup: func(build esbuild.PluginBuild) {
			// catch lib modules
			build.OnResolve(esbuild.OnResolveOptions{Filter: ".*"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
				// ignore .node files
				if strings.HasSuffix(args.Path, ".node") {
					return esbuild.OnResolveResult{
						External: true,
					}, nil
				}

				// node:fs => fs
				args.Path = strings.TrimPrefix(args.Path, "node:")
				// process/ => process
				args.Path = strings.TrimSuffix(args.Path, "/")

				libModulePath, isLibModule := libModules[args.Path]

				if !isLibModule {
					return esbuild.OnResolveResult{}, nil
				}

				return esbuild.OnResolveResult{
					Namespace: "lib",
					Path:      libModulePath,
				}, nil
			})

			pwd, _ := os.Getwd()

			// resolve relative import in lib modules
			build.OnResolve(esbuild.OnResolveOptions{Namespace: "lib", Filter: ".*"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
				if !strings.HasPrefix(args.ResolveDir, "/") {
					dir, _ := filepath.Rel(pwd, args.ResolveDir)
					args.ResolveDir = "/" + filepath.ToSlash(dir)
				}

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
}

func prepareTailwindcssPlugin(tailwindcssEntry *string, sourceFiles *[]string) esbuild.Plugin {
	return esbuild.Plugin{
		Name: "tailwindcss",
		Setup: func(build esbuild.PluginBuild) {
			// catch lib modules
			build.OnResolve(esbuild.OnResolveOptions{Filter: ".*"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
				if args.Path == "tailwindcss" && strings.HasSuffix(args.Importer, ".css") {
					*tailwindcssEntry = args.Importer
					return esbuild.OnResolveResult{
						Path:      args.Path,
						Namespace: "tailwindcss",
					}, nil
				}

				return esbuild.OnResolveResult{}, nil
			})

			build.OnLoad(esbuild.OnLoadOptions{Filter: ".*"}, func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
				if args.Namespace != "lib" && args.Namespace != "tailwindcss" && !strings.Contains(args.Path, "node_modules") {
					*sourceFiles = append(*sourceFiles, args.Path)
				}
				return esbuild.OnLoadResult{}, nil
			})

			build.OnLoad(esbuild.OnLoadOptions{Namespace: "tailwindcss", Filter: ".*"}, func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
				str := ""
				return esbuild.OnLoadResult{
					Loader:   esbuild.LoaderCSS,
					Contents: &str,
				}, nil
			})
		},
	}
}

func tailwindCSSBuild(ctx *types.Context, entry string, outfile string, sources []string) error {
	builder, ok := builderTailwindCSS[ctx.Id]
	if !ok {
		return errors.New("no tailwindcss builder")
	}

	// entry and outfile relative to root
	data := []types.SerializableData{
		fspath.RelativeToRoot(ctx, entry),
		fspath.RelativeToRoot(ctx, outfile),
	}

	// sources relative to root
	for i := range sources {
		data = append(data, fspath.RelativeToRoot(ctx, sources[i]))
	}

	builder.wg.Add(1)
	store.StreamEvent(ctx, builder.streamId, "build", data, false)
	builder.wg.Wait()
	return nil
}
