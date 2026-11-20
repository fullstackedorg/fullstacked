package bundle

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	fspath "fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/internal/plugin"
	"fullstackedorg/fullstacked/types"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	esbuild "github.com/evanw/esbuild/pkg/api"
)

// The scan: one esbuild build of the project from its entry, every
// dependency, lib module and file left external. It lists the project's
// modules and the packages they import, and its errors are the errors a
// bundle of the project would report for its own code.
type scanResult struct {
	errors   []esbuild.Message
	warnings []esbuild.Message

	sources         map[string]fileStamp // absolute paths
	sourcesRelative []string             // relative to the root, as build plugins get them
	specs           []string             // the dependencies imported, sorted

	plugins       map[*types.ContextPlugin]*PluginParams
	pluginFilters []pluginFilter
}

func (state *transformState) scan(pluginCtx *types.Context) scanResult {
	result := scanResult{sources: map[string]fileStamp{}}

	options := esbuild.BuildOptions{
		EntryPoints:   []string{state.entry},
		Bundle:        true,
		Format:        esbuild.FormatESModule,
		Write:         false,
		AbsWorkingDir: state.root,
		Outdir:        filepath.Join(state.root, "out"),
		Loader:        transformLoaders(),
	}

	// the build plugins resolve first, as in a bundle
	if pluginCtx != nil {
		plugins, err := addContextBuildPluginsToBuildOptions(pluginCtx, &options)
		if err != nil {
			result.errors = []esbuild.Message{{Text: err.Error()}}
			return result
		}
		result.plugins = plugins
		result.pluginFilters = pluginFiltersOf(pluginCtx)
	}

	mu := sync.Mutex{}
	specs := map[string]bool{}
	sources := []string{}

	options.Plugins = append(options.Plugins, esbuild.Plugin{
		Name: "fullstacked-scan",
		Setup: func(build esbuild.PluginBuild) {
			build.OnResolve(esbuild.OnResolveOptions{Filter: ".*"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
				if args.Kind == esbuild.ResolveEntryPoint || isGuarded(args) || args.Namespace != "file" {
					return esbuild.OnResolveResult{}, nil
				}
				imp, errs := classifyImport(build, args, state.root)
				if len(errs) > 0 {
					return esbuild.OnResolveResult{Errors: errs}, nil
				}
				switch imp.kind {
				case importDep:
					mu.Lock()
					specs[imp.value] = true
					mu.Unlock()
					return esbuild.OnResolveResult{Path: imp.value, External: true}, nil
				case importLib:
					return esbuild.OnResolveResult{Path: args.Path, External: true}, nil
				case importModule:
					return esbuild.OnResolveResult{Path: imp.result.Path}, nil
				case importFile:
					// CSS is read: the build plugins see what it imports
					// (@import "tailwindcss"), as in a bundle
					if path.Ext(imp.result.Path) == ".css" {
						return esbuild.OnResolveResult{Path: imp.result.Path}, nil
					}
					return esbuild.OnResolveResult{Path: imp.value, External: true}, nil
				}
				return imp.result, nil
			})
			build.OnLoad(esbuild.OnLoadOptions{Filter: ".*", Namespace: "file"}, func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
				mu.Lock()
				sources = append(sources, args.Path)
				mu.Unlock()
				return esbuild.OnLoadResult{}, nil
			})
		},
	})

	built := esbuild.Build(options)
	result.errors = built.Errors
	result.warnings = built.Warnings

	sort.Strings(sources)
	for _, source := range sources {
		if stamp, ok := stampOf(source); ok {
			result.sources[source] = stamp
		}
		// as a bundle gives them to build plugins: relative to the cwd of
		// the context that registered them
		if pluginCtx != nil {
			result.sourcesRelative = append(result.sourcesRelative, fspath.RelativeToCwd(pluginCtx, source))
		}
	}
	for spec := range specs {
		result.specs = append(result.specs, spec)
	}
	sort.Strings(result.specs)
	return result
}

// the loaders of a bundle for the files it bundles (images as files)
func transformLoaders() map[string]esbuild.Loader {
	return map[string]esbuild.Loader{
		".png":  esbuild.LoaderFile,
		".jpg":  esbuild.LoaderFile,
		".jpeg": esbuild.LoaderFile,
		".gif":  esbuild.LoaderFile,
		".svg":  esbuild.LoaderFile,
	}
}

func pluginFiltersOf(ctx *types.Context) []pluginFilter {
	filters := []pluginFilter{}
	for _, p := range plugin.GetPluginsOfTypes(ctx, types.PluginTypeBuild) {
		data := PluginBuildData{}
		if json.Unmarshal(p.Data.Data, &data) == nil {
			filters = append(filters, pluginFilter{name: p.Name, data: data})
		}
	}
	return filters
}

// The dependencies, built once and cached in node_modules/.fullstacked/deps.
// One esbuild build with an entry per specifier the project imports, split
// so packages share chunks: each package loads once per page, whichever
// specifiers import it. Each entry is a facade: its default export is the
// package as a bundle's interop sees it (transform-lib.go, proxies).
type depsBuild struct {
	key   string
	specs []string          // sorted
	urls  map[string]string // specifier → page path
	files map[string][]byte // page path → contents
	css   []string          // the stylesheets the packages import, linked in the page
	// the lib modules the packages import (/@lib/...), preloaded
	libImports []string
}

type depsManifest struct {
	Key        string            `json:"key"`
	Specs      []string          `json:"specs"`
	Urls       map[string]string `json:"urls"`
	Files      []string          `json:"files"`
	Css        []string          `json:"css"`
	LibImports []string          `json:"libImports"`
}

const depsFacadeNamespace = "fullstacked-dep"

func depsCacheDir(root string) string {
	return filepath.Join(root, "node_modules", ".fullstacked", "deps")
}

// What the dependencies are built from: the packages installed, this core
// (its lib) and esbuild, and the specifiers.
func depsKey(root string, specs []string) string {
	hash := sha256.New()
	version, _ := json.Marshal(FullStackedVersion())
	hash.Write(version)
	hash.Write([]byte(EsbuildVersionFn()))
	for _, file := range []string{
		"package.json",
		"package-lock.json",
		"yarn.lock",
		"pnpm-lock.yaml",
		"bun.lock",
		// npm's record of what node_modules holds, also without a lockfile
		filepath.Join("node_modules", ".package-lock.json"),
	} {
		contents, err := os.ReadFile(filepath.Join(root, file))
		hash.Write([]byte(file))
		if err == nil {
			hash.Write(contents)
		}
	}
	for _, spec := range specs {
		hash.Write([]byte{0})
		hash.Write([]byte(spec))
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// the dependencies for specs: the current build when it has them, else the
// cache on disk, else a new build (written to the cache)
func ensureDeps(root string, specs []string, current *depsBuild) (*depsBuild, []esbuild.Message) {
	if len(specs) == 0 {
		return &depsBuild{urls: map[string]string{}, files: map[string][]byte{}}, nil
	}

	key := depsKey(root, specs)
	if current != nil && current.key == key {
		return current, nil
	}

	if cached := readDepsCache(root, key); cached != nil {
		return cached, nil
	}

	build, errs := buildDeps(root, specs, key)
	if len(errs) > 0 {
		return nil, errs
	}
	writeDepsCache(root, build)
	return build, nil
}

var unsafeOutputChars = regexp.MustCompile(`[^A-Za-z0-9@._/-]`)

// the output name of a specifier: its own path, so the page path reads like
// the import (/@deps/react-dom/client.js)
func depOutputName(spec string, taken map[string]bool) string {
	name := strings.TrimPrefix(spec, "./")
	name = unsafeOutputChars.ReplaceAllString(name, "_")
	parts := strings.Split(name, "/")
	for i, part := range parts {
		if part == "" || part == "." || part == ".." || strings.HasPrefix(part, "_") {
			parts[i] = "-" + part
		}
	}
	name = strings.Join(parts, "/")
	unique := name
	for i := 2; taken[unique]; i++ {
		unique = name + "-" + itoa(i)
	}
	taken[unique] = true
	return unique
}

func buildDeps(root string, specs []string, key string) (*depsBuild, []esbuild.Message) {
	taken := map[string]bool{}
	entries := []esbuild.EntryPoint{}
	outputs := map[string]string{}
	for _, spec := range specs {
		output := depOutputName(spec, taken)
		outputs[spec] = output
		entries = append(entries, esbuild.EntryPoint{InputPath: depsFacadeNamespace + ":" + spec, OutputPath: output})
	}

	outdir := filepath.Join(os.TempDir(), "fullstacked-transform", "deps")
	result := esbuild.Build(esbuild.BuildOptions{
		EntryPointsAdvanced: entries,
		Bundle:              true,
		Splitting:           true,
		Format:              esbuild.FormatESModule,
		Write:               false,
		AbsWorkingDir:       root,
		Outdir:              outdir,
		ChunkNames:          "_chunks/[name]-[hash]",
		AssetNames:          "_assets/[name]-[hash]",
		PublicPath:          strings.TrimSuffix(transformDepsPrefix, "/"),
		Loader:              transformLoaders(),
		Metafile:            true,
		Plugins: []esbuild.Plugin{{
			Name: "fullstacked-deps",
			Setup: func(build esbuild.PluginBuild) {
				build.OnResolve(esbuild.OnResolveOptions{Filter: "^" + depsFacadeNamespace + ":"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
					return esbuild.OnResolveResult{Path: strings.TrimPrefix(args.Path, depsFacadeNamespace+":"), Namespace: depsFacadeNamespace}, nil
				})
				build.OnLoad(esbuild.OnLoadOptions{Filter: ".*", Namespace: depsFacadeNamespace}, func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
					contents := depFacade(args.Path)
					return esbuild.OnLoadResult{Contents: &contents, ResolveDir: root, Loader: esbuild.LoaderJS}, nil
				})
				// the lib modules the packages import stay the page's
				build.OnResolve(esbuild.OnResolveOptions{Filter: ".*"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
					if args.Namespace == proxyCJSNamespace || args.Namespace == proxyESMNamespace {
						return esbuild.OnResolveResult{}, nil
					}
					if strings.HasSuffix(args.Path, ".node") {
						return esbuild.OnResolveResult{Path: args.Path, External: true}, nil
					}
					if name, ok := libModuleName(args.Path); ok {
						return libImportResult(name, args.Kind), nil
					}
					return esbuild.OnResolveResult{}, nil
				})
				addProxies(build)
			},
		}},
	})
	if len(result.Errors) > 0 {
		return nil, result.Errors
	}

	build := &depsBuild{
		key:   key,
		specs: specs,
		urls:  map[string]string{},
		files: map[string][]byte{},
	}
	for spec, output := range outputs {
		build.urls[spec] = transformDepsPrefix + output + ".js"
	}
	for _, file := range result.OutputFiles {
		rel, err := filepath.Rel(outdir, file.Path)
		if err != nil {
			continue
		}
		pagePath := transformDepsPrefix + filepath.ToSlash(rel)
		build.files[pagePath] = file.Contents
		if strings.HasSuffix(pagePath, ".css") {
			build.css = append(build.css, pagePath)
		}
	}
	sort.Strings(build.css)
	libImports := map[string]bool{}
	for _, imports := range staticImports(result.Metafile, root, outdir, transformDepsPrefix) {
		for _, imp := range imports {
			if strings.HasPrefix(imp, transformLibPrefix) {
				libImports[imp] = true
			}
		}
	}
	for imp := range libImports {
		build.libImports = append(build.libImports, imp)
	}
	sort.Strings(build.libImports)
	return build, nil
}

// The default export of a facade is the package as a bundle's interop sees
// it, marked __esModule so the importer's interop keeps it: named imports
// read its properties, a default import gets its "default" (module.exports
// for a CommonJS package), a namespace import gets it whole.
func depFacade(spec string) string {
	return "import * as ns from " + jsString(spec) + ";\n" +
		"const target = Object.create(Object.getPrototypeOf(ns));\n" +
		"for (const key of Object.getOwnPropertyNames(ns)) {\n" +
		"  if (key === \"__esModule\") continue;\n" +
		"  const desc = Object.getOwnPropertyDescriptor(ns, key);\n" +
		"  Object.defineProperty(target, key, { get: () => ns[key], enumerable: !desc || desc.enumerable });\n" +
		"}\n" +
		"Object.defineProperty(target, \"__esModule\", { value: true });\n" +
		"export default target;\n"
}

func readDepsCache(root string, key string) *depsBuild {
	dir := depsCacheDir(root)
	contents, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil
	}
	manifest := depsManifest{}
	if json.Unmarshal(contents, &manifest) != nil || manifest.Key != key {
		return nil
	}
	build := &depsBuild{
		key:        key,
		specs:      manifest.Specs,
		urls:       manifest.Urls,
		files:      map[string][]byte{},
		css:        manifest.Css,
		libImports: manifest.LibImports,
	}
	for _, pagePath := range manifest.Files {
		file, ok := insideRoot(dir, strings.TrimPrefix(pagePath, transformDepsPrefix))
		if !ok {
			return nil
		}
		data, err := os.ReadFile(file)
		if err != nil {
			return nil
		}
		build.files[pagePath] = data
	}
	return build
}

// best effort: a project that can't write its node_modules builds again
func writeDepsCache(root string, build *depsBuild) {
	dir := depsCacheDir(root)
	if _, err := os.Stat(filepath.Dir(filepath.Dir(dir))); err != nil {
		return
	}
	os.RemoveAll(dir)
	manifest := depsManifest{
		Key:        build.key,
		Specs:      build.specs,
		Urls:       build.urls,
		Css:        build.css,
		LibImports: build.libImports,
	}
	for pagePath, contents := range build.files {
		file, ok := insideRoot(dir, strings.TrimPrefix(pagePath, transformDepsPrefix))
		if !ok {
			continue
		}
		if os.MkdirAll(filepath.Dir(file), 0755) != nil || os.WriteFile(file, contents, 0644) != nil {
			return
		}
		manifest.Files = append(manifest.Files, pagePath)
	}
	sort.Strings(manifest.Files)
	data, _ := json.Marshal(manifest)
	os.WriteFile(filepath.Join(dir, "manifest.json"), data, 0644)
}
