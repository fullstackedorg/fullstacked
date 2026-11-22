package bundle

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fullstackedorg/fullstacked/internal/fs"
	iofs "io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	esbuild "github.com/evanw/esbuild/pkg/api"
	"golang.org/x/net/html"
)

// The runtime lib as ES modules, built once per core. Every page loads the
// lib's prelude (the fullstacked module: the bridge, process, Buffer...):
// it is one file, /@lib/fullstacked/index.js, which also exports a namespace
// of each lib file it holds. A lib module among them (fs, path, events...) is
// a facade over that namespace; the other modules (crypto, zlib, git...) are
// built split, and what they share with the prelude is read from it through
// the proxies a project's modules use. A page's modules, its dependencies
// and the lib's own modules import the same /@lib/ URLs: one bridge per page.
type libBuild struct {
	urls   map[string]string // module name (fs, fs/promises...) → page path
	files  map[string][]byte // page path → contents
	errors []esbuild.Message
	// page path → the page paths it imports statically (its chunks)
	imports map[string][]string
}

type metafile struct {
	Inputs map[string]struct {
		Imports []struct {
			Path string `json:"path"`
			Kind string `json:"kind"`
		} `json:"imports"`
	} `json:"inputs"`
	Outputs map[string]struct {
		Imports []struct {
			Path     string `json:"path"`
			Kind     string `json:"kind"`
			External bool   `json:"external"`
		} `json:"imports"`
		Exports []string `json:"exports"`
	} `json:"outputs"`
}

// The static imports of each output of a build, by page path: from its
// metafile (output paths relative to workingDir), the outputs under prefix,
// external imports as they are (/@lib/...).
func staticImports(meta string, workingDir string, outdir string, prefix string) map[string][]string {
	parsed := metafile{}
	imports := map[string][]string{}
	if json.Unmarshal([]byte(meta), &parsed) != nil {
		return imports
	}
	pagePath := func(output string) (string, bool) {
		if !filepath.IsAbs(output) {
			output = filepath.Join(workingDir, output)
		}
		rel, err := filepath.Rel(outdir, output)
		if err != nil || strings.HasPrefix(rel, "..") {
			return "", false
		}
		return prefix + filepath.ToSlash(rel), true
	}
	for output, info := range parsed.Outputs {
		from, ok := pagePath(output)
		if !ok {
			continue
		}
		for _, imp := range info.Imports {
			if imp.Kind != "import-statement" {
				continue
			}
			if imp.External {
				imports[from] = append(imports[from], imp.Path)
			} else if to, ok := pagePath(imp.Path); ok {
				imports[from] = append(imports[from], to)
			}
		}
	}
	return imports
}

// The lib, from the cache of this lib (the user's cache folder) when it
// has it: a build takes a few esbuild runs, at every start of a process.
var transformLib = sync.OnceValue(func() *libBuild {
	key := libKey()
	if cached := readLibCache(key); cached != nil {
		return cached
	}
	build := buildTransformLib()
	if len(build.errors) == 0 {
		writeLibCache(key, build)
	}
	return build
})

// the embedded lib's files and esbuild: what the lib's build is made of
func libKey() string {
	hash := sha256.New()
	hash.Write([]byte(EsbuildVersionFn()))
	iofs.WalkDir(lib, "lib", func(file string, entry iofs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		contents, _ := lib.ReadFile(file)
		hash.Write([]byte(file))
		hash.Write(contents)
		return nil
	})
	return hex.EncodeToString(hash.Sum(nil))[:24]
}

type libManifest struct {
	Urls    map[string]string   `json:"urls"`
	Imports map[string][]string `json:"imports"`
	Files   []string            `json:"files"`
}

func libCacheDir(key string) (string, bool) {
	dir, err := os.UserCacheDir()
	if err != nil || dir == "" {
		return "", false
	}
	return filepath.Join(dir, "fullstacked", "transform-lib", key), true
}

func readLibCache(key string) *libBuild {
	dir, ok := libCacheDir(key)
	if !ok {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return nil
	}
	manifest := libManifest{}
	if json.Unmarshal(data, &manifest) != nil {
		return nil
	}
	build := &libBuild{urls: manifest.Urls, imports: manifest.Imports, files: map[string][]byte{}}
	for _, pagePath := range manifest.Files {
		file, ok := insideRoot(dir, strings.TrimPrefix(pagePath, transformLibPrefix))
		if !ok {
			return nil
		}
		contents, err := os.ReadFile(file)
		if err != nil {
			return nil
		}
		build.files[pagePath] = contents
	}
	return build
}

// best effort: without a cache folder, each process builds the lib
func writeLibCache(key string, build *libBuild) {
	dir, ok := libCacheDir(key)
	if !ok {
		return
	}
	// another process may write it at the same time: written aside, then moved
	tmp := dir + ".tmp-" + itoa(os.Getpid())
	os.RemoveAll(tmp)
	manifest := libManifest{Urls: build.urls, Imports: build.imports}
	for pagePath, contents := range build.files {
		file, ok := insideRoot(tmp, strings.TrimPrefix(pagePath, transformLibPrefix))
		if !ok {
			continue
		}
		if os.MkdirAll(filepath.Dir(file), 0755) != nil || os.WriteFile(file, contents, 0644) != nil {
			os.RemoveAll(tmp)
			return
		}
		manifest.Files = append(manifest.Files, pagePath)
	}
	sort.Strings(manifest.Files)
	data, _ := json.Marshal(manifest)
	if os.WriteFile(filepath.Join(tmp, "manifest.json"), data, 0644) != nil {
		os.RemoveAll(tmp)
		return
	}
	if os.Rename(tmp, dir) != nil {
		os.RemoveAll(tmp)
		return
	}
	// the builds of other libs (an older core) are not kept
	parent := filepath.Dir(dir)
	if entries, err := os.ReadDir(parent); err == nil {
		for _, entry := range entries {
			if entry.Name() != key && !strings.Contains(entry.Name(), ".tmp-") {
				os.RemoveAll(filepath.Join(parent, entry.Name()))
			}
		}
	}
}

const (
	libFilePrefix  = "fullstacked-lib-file:"
	libPreludeName = "fullstacked-lib-prelude"
)

// esbuild reads an entry point named like a file of the working directory
// from that file, matching names regardless of case: the iOS app's working
// directory holds its executable, FullStacked. node: keeps the entry a module
// name (the lib plugin drops it)
func libEntryOf(name string) string {
	return "node:" + name
}

// a lib file of the prelude, as a bundle's lib plugin names it
func libFileOf(args esbuild.OnResolveArgs, pwd string) (string, bool) {
	if args.Namespace == "lib-require" || args.Kind == esbuild.ResolveEntryPoint {
		return "", false
	}
	if name, ok := libModuleName(args.Path); ok {
		return libModules[name], true
	}
	if args.Namespace != "lib" {
		return "", false
	}
	resolveDir := args.ResolveDir
	if !strings.HasPrefix(resolveDir, "/") {
		dir, _ := filepath.Rel(pwd, resolveDir)
		resolveDir = "/" + filepath.ToSlash(dir)
	}
	return path.Join(resolveDir, args.Path), true
}

func buildTransformLib() *libBuild {
	build := &libBuild{
		urls:    map[string]string{},
		files:   map[string][]byte{},
		imports: map[string][]string{},
	}
	outdir := filepath.Join(os.TempDir(), "fullstacked-transform", "lib")
	cwd, _ := os.Getwd()

	// one entry per file: several names share one (unavailable/index.ts)
	namesByFile := map[string][]string{}
	for name, file := range libModules {
		namesByFile[file] = append(namesByFile[file], name)
	}
	outputOf := map[string]string{}
	allEntries := []esbuild.EntryPoint{}
	for file, names := range namesByFile {
		sort.Strings(names)
		output := strings.TrimSuffix(strings.TrimPrefix(file, "/lib/"), path.Ext(file))
		outputOf[file] = output
		allEntries = append(allEntries, esbuild.EntryPoint{InputPath: libEntryOf(names[0]), OutputPath: output})
	}
	sort.Slice(allEntries, func(i, j int) bool { return allEntries[i].OutputPath < allEntries[j].OutputPath })

	// the export names of each module: a split build of them all
	split := esbuild.Build(esbuild.BuildOptions{
		EntryPointsAdvanced: allEntries,
		Bundle:              true,
		Splitting:           true,
		Format:              esbuild.FormatESModule,
		Write:               false,
		Outdir:              outdir,
		Plugins:             esbuildPluginsLib,
		Metafile:            true,
	})
	if len(split.Errors) > 0 {
		build.errors = split.Errors
		return build
	}
	splitMeta := metafile{}
	json.Unmarshal([]byte(split.Metafile), &splitMeta)
	exportsOf := map[string][]string{}
	for output, info := range splitMeta.Outputs {
		abs := output
		if !filepath.IsAbs(abs) {
			abs = filepath.Join(cwd, abs)
		}
		if rel, err := filepath.Rel(outdir, abs); err == nil {
			exportsOf[strings.TrimSuffix(filepath.ToSlash(rel), ".js")] = info.Exports
		}
	}

	// its files: what the bridge's init imports dynamically (platform,
	// timers, buffer, process) is loaded by every page and goes in the
	// prelude; the DOMParser of workers stays in chunks of its own
	static := map[string]bool{}
	var reach func(input string)
	reach = func(input string) {
		if static[input] || strings.HasPrefix(input, "lib:/lib/DOMParser/") {
			return
		}
		static[input] = true
		for _, imp := range splitMeta.Inputs[input].Imports {
			if imp.Kind == "import-statement" || imp.Kind == "dynamic-import" {
				reach(imp.Path)
			}
		}
	}
	reach("lib:" + libModules["fullstacked"])
	preludeFiles := []string{}
	for input := range static {
		if strings.HasPrefix(input, "lib:") {
			preludeFiles = append(preludeFiles, strings.TrimPrefix(input, "lib:"))
		}
	}
	sort.Strings(preludeFiles)
	exportOfFile := map[string]string{}
	for i, file := range preludeFiles {
		exportOfFile[file] = "__lib" + itoa(i)
	}

	// the prelude: the fullstacked module, and a namespace of each of its files
	preludeOutput := outputOf[libModules["fullstacked"]]
	preludeURL := transformLibPrefix + preludeOutput + ".js"
	preludeSource := "export * from \"fullstacked\";\nexport { default } from \"fullstacked\";\n"
	for _, file := range preludeFiles {
		preludeSource += "export * as " + exportOfFile[file] + " from " + jsString(libFilePrefix+file) + ";\n"
	}
	preludePlugin := esbuild.Plugin{
		Name: "fullstacked-lib-prelude",
		Setup: func(b esbuild.PluginBuild) {
			b.OnResolve(esbuild.OnResolveOptions{Filter: "^" + libPreludeName + "$"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
				return esbuild.OnResolveResult{Path: libPreludeName, Namespace: libPreludeName}, nil
			})
			b.OnLoad(esbuild.OnLoadOptions{Filter: ".*", Namespace: libPreludeName}, func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
				return esbuild.OnLoadResult{Contents: &preludeSource, Loader: esbuild.LoaderJS, ResolveDir: "/lib"}, nil
			})
			b.OnResolve(esbuild.OnResolveOptions{Filter: "^" + libFilePrefix}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
				return esbuild.OnResolveResult{Path: strings.TrimPrefix(args.Path, libFilePrefix), Namespace: "lib"}, nil
			})
		},
	}
	// one file: the DOMParser of workers is the only import it leaves out
	domParserURL := transformLibPrefix + "_prelude/DOMParser.js"
	domParserExternal := esbuild.Plugin{
		Name: "fullstacked-lib-domparser",
		Setup: func(b esbuild.PluginBuild) {
			b.OnResolve(esbuild.OnResolveOptions{Filter: "DOMParser", Namespace: "lib"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
				if args.Kind != esbuild.ResolveJSDynamicImport {
					return esbuild.OnResolveResult{}, nil
				}
				return esbuild.OnResolveResult{Path: domParserURL, External: true}, nil
			})
		},
	}
	prelude := esbuild.Build(esbuild.BuildOptions{
		EntryPointsAdvanced: []esbuild.EntryPoint{{InputPath: libPreludeName, OutputPath: preludeOutput}},
		Bundle:              true,
		Format:              esbuild.FormatESModule,
		Write:               false,
		Outdir:              outdir,
		Plugins:             append([]esbuild.Plugin{domParserExternal, preludePlugin}, esbuildPluginsLib...),
		Metafile:            true,
	})
	if len(prelude.Errors) > 0 {
		build.errors = prelude.Errors
		return build
	}
	for _, file := range prelude.OutputFiles {
		if rel, err := filepath.Rel(outdir, file.Path); err == nil {
			build.files[transformLibPrefix+filepath.ToSlash(rel)] = file.Contents
		}
	}
	for from, imports := range staticImports(prelude.Metafile, cwd, outdir, transformLibPrefix) {
		build.imports[from] = append(build.imports[from], imports...)
	}

	// the modules among the prelude's files: facades over its namespaces
	inPrelude := map[string]bool{}
	for _, file := range preludeFiles {
		inPrelude[file] = true
	}
	restEntries := []esbuild.EntryPoint{{InputPath: libFilePrefix + "/lib/DOMParser/index.ts", OutputPath: "_prelude/DOMParser"}}
	for _, entry := range allEntries {
		file := libModules[strings.TrimPrefix(entry.InputPath, "node:")]
		if !inPrelude[file] {
			restEntries = append(restEntries, entry)
			continue
		}
		if file == libModules["fullstacked"] {
			continue
		}
		pagePath := transformLibPrefix + entry.OutputPath + ".js"
		build.files[pagePath] = libFacade(preludeURL, exportOfFile[file], exportsOf[entry.OutputPath])
		build.imports[pagePath] = []string{preludeURL}
	}

	// the other modules, split; the prelude's files are read from it
	pwd, _ := os.Getwd()
	preludeProxies := esbuild.Plugin{
		Name: "fullstacked-lib-from-prelude",
		Setup: func(b esbuild.PluginBuild) {
			b.OnResolve(esbuild.OnResolveOptions{Filter: "^" + libFilePrefix}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
				return esbuild.OnResolveResult{Path: strings.TrimPrefix(args.Path, libFilePrefix), Namespace: "lib"}, nil
			})
			b.OnResolve(esbuild.OnResolveOptions{Filter: ".*"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
				if args.Namespace == proxyCJSNamespace || args.Namespace == proxyESMNamespace {
					return esbuild.OnResolveResult{}, nil
				}
				file, ok := libFileOf(args, pwd)
				if !ok || !inPrelude[file] {
					return esbuild.OnResolveResult{}, nil
				}
				return proxyResult("lib-file:"+file, proxyTarget{url: preludeURL, export: exportOfFile[file]}), nil
			})
			addProxies(b)
		},
	}
	{
		rest := esbuild.Build(esbuild.BuildOptions{
			EntryPointsAdvanced: restEntries,
			Bundle:              true,
			Splitting:           true,
			Format:              esbuild.FormatESModule,
			Write:               false,
			Outdir:              outdir,
			ChunkNames:          "_chunks/[name]-[hash]",
			Plugins:             append([]esbuild.Plugin{preludeProxies}, esbuildPluginsLib...),
			Metafile:            true,
		})
		if len(rest.Errors) > 0 {
			build.errors = rest.Errors
			return build
		}
		for _, file := range rest.OutputFiles {
			rel, err := filepath.Rel(outdir, file.Path)
			if err != nil {
				continue
			}
			build.files[transformLibPrefix+filepath.ToSlash(rel)] = file.Contents
		}
		for from, imports := range staticImports(rest.Metafile, cwd, outdir, transformLibPrefix) {
			build.imports[from] = append(build.imports[from], imports...)
		}
	}

	for file, names := range namesByFile {
		for _, name := range names {
			build.urls[name] = transformLibPrefix + outputOf[file] + ".js"
		}
	}
	return build
}

var identifierName = regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]*$`)

// A lib module of the prelude: its exports, read from the prelude's
// namespace of its file (the names come from a build of the module).
func libFacade(preludeURL string, namespace string, exports []string) []byte {
	out := "import { " + namespace + " as ns } from " + jsString(preludeURL) + ";\n"
	for i, name := range exports {
		local := "__e" + itoa(i)
		out += "const " + local + " = ns[" + jsString(name) + "];\n"
		switch {
		case name == "default":
			out += "export default " + local + ";\n"
		case identifierName.MatchString(name):
			out += "export { " + local + " as " + name + " };\n"
		default:
			// a name that is not an identifier ("module.exports")
			out += "export { " + local + " as " + jsString(name) + " };\n"
		}
	}
	return []byte(out)
}

// The lib module a specifier names (fs, node:fs, fullstacked/git...), as the
// lib plugin of a bundle resolves it.
func libModuleName(specifier string) (string, bool) {
	name := strings.TrimPrefix(specifier, "node:")
	name = strings.TrimSuffix(name, "/")
	name = strings.TrimPrefix(name, "fullstacked/")
	_, ok := libModules[name]
	return name, ok
}

// An import of a module (a project file, a dependency) once resolved.
type importKind int

const (
	importExternal importKind = iota // left as is (a URL, a .node file)
	importLib                        // a lib module: /@lib/
	importDep                        // a dependency: /@deps/
	importModule                     // a module of the project: /<path>
	importFile                       // CSS, JSON, an image: /@import/<path>
	importOther                      // taken by another plugin (a build plugin)
)

type resolvedImport struct {
	kind   importKind
	value  string // lib module name, dependency specifier, page path
	result esbuild.OnResolveResult
}

// the PluginData of a Resolve made from an OnResolve: that call goes on to
// esbuild's own resolution
type resolveGuard struct{}

var guard = &resolveGuard{}

func isGuarded(args esbuild.OnResolveArgs) bool {
	g, ok := args.PluginData.(*resolveGuard)
	return ok && g == guard
}

func isBareSpecifier(specifier string) bool {
	return !strings.HasPrefix(specifier, ".") && !strings.HasPrefix(specifier, "/") &&
		!filepath.IsAbs(specifier)
}

func inNodeModules(file string) bool {
	return strings.Contains(filepath.ToSlash(file), "/node_modules/")
}

// Resolves an import of a module of the project like a bundle would, and
// tells what transform mode does with it. errors: the import fails.
func classifyImport(build esbuild.PluginBuild, args esbuild.OnResolveArgs, root string) (resolvedImport, []esbuild.Message) {
	if strings.HasSuffix(args.Path, ".node") || strings.HasPrefix(args.Path, "data:") ||
		strings.HasPrefix(args.Path, "http://") || strings.HasPrefix(args.Path, "https://") {
		return resolvedImport{kind: importExternal, result: esbuild.OnResolveResult{Path: args.Path, External: true}}, nil
	}

	if name, ok := libModuleName(args.Path); ok {
		return resolvedImport{kind: importLib, value: name}, nil
	}

	resolved := build.Resolve(args.Path, esbuild.ResolveOptions{
		Importer:   args.Importer,
		ResolveDir: args.ResolveDir,
		Kind:       args.Kind,
		Namespace:  args.Namespace,
		PluginData: guard,
		With:       args.With,
	})
	if len(resolved.Errors) > 0 {
		return resolvedImport{}, resolved.Errors
	}
	if resolved.External {
		return resolvedImport{kind: importExternal, result: esbuild.OnResolveResult{Path: resolved.Path, External: true}}, nil
	}
	if resolved.Namespace != "file" {
		return resolvedImport{kind: importOther, result: esbuild.OnResolveResult{
			Path:       resolved.Path,
			Namespace:  resolved.Namespace,
			PluginData: resolved.PluginData,
		}}, nil
	}

	file := resolved.Path
	ext := path.Ext(file)
	isModule := ext == "" || transformModuleExtensions[ext]
	pageURL, inside := urlOf(root, file)

	if isModule && (inNodeModules(file) || !inside) {
		specifier := args.Path
		if !isBareSpecifier(specifier) {
			if inside {
				specifier = "." + pageURL
			} else {
				// a module outside of the project (../shared/x.ts): a bundle includes it, so
				// it is built with the dependencies, by its path (depsKey watches it)
				specifier = file
			}
		}
		return resolvedImport{kind: importDep, value: specifier}, nil
	}

	if !inside {
		return resolvedImport{}, []esbuild.Message{{Text: "Could not resolve \"" + args.Path + "\": it is outside of the project"}}
	}

	if isModule {
		return resolvedImport{kind: importModule, value: pageURL, result: esbuild.OnResolveResult{Path: file}}, nil
	}

	return resolvedImport{kind: importFile, value: transformImportPrefix + strings.TrimPrefix(pageURL, "/"), result: esbuild.OnResolveResult{Path: file}}, nil
}

// require() of a lib module or of a dependency, in a module transformed on
// its own: a CommonJS module whose exports are the ES module at url. esbuild
// then gives every import of it (named, default, namespace, dynamic, require)
// the same interop as in a bundle.
const (
	proxyCJSNamespace = "fullstacked-proxy-cjs"
	proxyESMNamespace = "fullstacked-proxy-esm"
)

// the url a proxy stands for, and how its value is read: a lib module
// required gets its "module.exports" when it has one (see libRequireAdapter),
// a dependency its facade (transform-deps.go)
type proxyTarget struct {
	url string
	lib bool
	// a namespace the module at url exports (a lib file of the prelude)
	export string
	// a dependency imported by import or import(): the names the project
	// imports from it, exported as such (see depImportResult)
	names []string
	// a dependency required: what require() gets, its facade's
	// "module.exports" when it has one (see depImportResult)
	required bool
}

func addProxies(build esbuild.PluginBuild) {
	build.OnLoad(esbuild.OnLoadOptions{Filter: ".*", Namespace: proxyCJSNamespace}, func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
		contents := "module.exports = require(" + jsString(args.Path) + ").default;\n"
		return esbuild.OnLoadResult{Contents: &contents, Loader: esbuild.LoaderJS, PluginData: args.PluginData}, nil
	})
	build.OnResolve(esbuild.OnResolveOptions{Filter: ".*", Namespace: proxyCJSNamespace}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
		return esbuild.OnResolveResult{Path: args.Path, Namespace: proxyESMNamespace, PluginData: args.PluginData}, nil
	})
	build.OnLoad(esbuild.OnLoadOptions{Filter: ".*", Namespace: proxyESMNamespace}, func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
		target, _ := args.PluginData.(proxyTarget)
		contents := ""
		if target.export != "" {
			contents = "import { " + target.export + " as ns } from " + jsString(target.url) + ";\n" +
				namespaceFacade("ns") + "export default target;\n"
		} else if len(target.names) > 0 {
			contents = "import m from " + jsString(target.url) + ";\n"
			exports := []string{}
			for i, name := range target.names {
				contents += "const __n" + itoa(i) + " = m[" + jsString(name) + "];\n"
				exports = append(exports, "__n"+itoa(i)+" as "+jsString(name))
			}
			contents += "export { " + strings.Join(exports, ", ") + " };\n"
		} else if target.required {
			contents = "import m from " + jsString(target.url) + ";\n" +
				"export default m && m[\"module.exports\"] !== undefined ? m[\"module.exports\"] : m;\n"
		} else if target.lib {
			contents = "import * as m from " + jsString(target.url) + ";\n" +
				"export default m && m[\"module.exports\"] !== undefined ? m[\"module.exports\"] : m;\n"
		} else {
			contents = "import m from " + jsString(target.url) + ";\nexport default m;\n"
		}
		return esbuild.OnLoadResult{Contents: &contents, Loader: esbuild.LoaderJS}, nil
	})
	build.OnResolve(esbuild.OnResolveOptions{Filter: ".*", Namespace: proxyESMNamespace}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
		return esbuild.OnResolveResult{Path: args.Path, External: true}, nil
	})
}

// A dependency (its facade at url) as a module imports it. A CommonJS
// package: the CommonJS proxy of its module.exports, read through esbuild's
// interop as in a bundle (in a "type": "module" package a default import gets
// the whole of it, Node's rule). An ES module package by import or import():
// a module that exports the names the project imports (all those the package
// exports when it is imported whole), so a default import gets its default
// export whatever the importer's module type; required, its facade.
func depImportResult(spec string, url string, deps *depsBuild, kind esbuild.ResolveKind) esbuild.OnResolveResult {
	if deps.commonJS[spec] {
		return proxyResult("dep:"+spec, proxyTarget{url: url, required: true})
	}
	names := usageOf(deps.usage, spec)
	if len(names) == 1 && names[0] == allExports {
		names = append([]string{"default"}, deps.exports[spec]...)
	}
	byImport := kind == esbuild.ResolveJSImportStatement || kind == esbuild.ResolveJSDynamicImport
	if byImport && len(names) > 0 {
		return esbuild.OnResolveResult{Path: "dep-import:" + spec, Namespace: proxyESMNamespace, PluginData: proxyTarget{url: url, names: names}}
	}
	return proxyResult("dep:"+spec, proxyTarget{url: url})
}

func proxyResult(key string, target proxyTarget) esbuild.OnResolveResult {
	return esbuild.OnResolveResult{Path: key, Namespace: proxyCJSNamespace, PluginData: target}
}

// a lib module imported: its URL, required: a proxy
func libImportResult(name string, kind esbuild.ResolveKind) esbuild.OnResolveResult {
	url := transformLib().urls[name]
	if kind == esbuild.ResolveJSRequireCall || kind == esbuild.ResolveJSRequireResolve {
		return proxyResult("lib:"+name, proxyTarget{url: url, lib: true})
	}
	return esbuild.OnResolveResult{Path: url, External: true}
}

func jsString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func itoa(i int) string {
	return strconv.Itoa(i)
}

func textNode(text string) *html.Node {
	return &html.Node{Type: html.TextNode, Data: text}
}

func renderDoc(doc DocumentHTML) []byte {
	out := bytes.Buffer{}
	html.Render(&out, doc.root)
	return out.Bytes()
}

// a file of the project imported by a module, served as a module: CSS adds its stylesheet, JSON
// is its value, any other file is its URL (as the file loader of a bundle)
func importedFileModule(root string, file string) []byte {
	pageURL, _ := urlOf(root, file)
	switch path.Ext(file) {
	case ".css":
		// the stylesheet bundled (/@css/), before the plugins' outputs
		cssURL := transformCSSPrefix + strings.TrimPrefix(pageURL, "/")
		return []byte("const link = document.createElement(\"link\");\n" +
			"link.rel = \"stylesheet\";\n" +
			"link.href = " + jsString(cssURL) + ";\n" +
			"if (typeof document !== \"undefined\") {\n" +
			"  document.head.insertBefore(link, document.head.querySelector(\"link[data-fullstacked-plugin]\"));\n" +
			"}\n" +
			"export default " + jsString(cssURL) + ";\n")
	case ".json":
		contents, err := fs.ReadFileFn(file)
		if err != nil || !json.Valid(contents) {
			return []byte("throw new SyntaxError(" + jsString("Invalid JSON: "+pageURL) + ");\n")
		}
		return append(append([]byte("export default "), contents...), []byte(";\n")...)
	}
	return []byte("export default " + jsString(pageURL) + ";\n")
}
