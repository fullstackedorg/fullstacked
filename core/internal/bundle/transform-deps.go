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

	// the project's stylesheets, bundled in import order as a bundle's
	// index.css (/@fullstacked/style.css), and the CSS files in it
	style      []byte
	cssSources map[string]bool

	// what the project imports from each dependency
	usage depUsage
	// the lib modules it imports
	libs []string
}

// The names a project imports from each dependency: its facade imports
// only these, so esbuild tree-shakes the package as in a bundle. "*": the
// whole package (a namespace import, import(), export *, require()).
type depUsage map[string][]string

const allExports = "*"

var (
	externalImportOrExport = regexp.MustCompile(`(?s)(?:^|\n)\s*(import|export)\s+([^;"]*?)\s+from\s*"([^"]+)"`)
	externalSideEffect     = regexp.MustCompile(`(?:^|\n)\s*import\s*"([^"]+)"`)
	externalDynamic        = regexp.MustCompile(`(?:\bimport|__require)\(\s*"([^"]+)"\s*\)`)
)

var lineComments = regexp.MustCompile(`(?m)^\s*//.*$|(?s)(?:^|\n)\s*/\*.*?\*/`)

// The names read from a namespace import in output (ns.name), false when it
// is used otherwise: passed along, spread, read with a computed key.
func namespaceMembers(output []byte, namespace string) ([]string, bool) {
	if !identifierName.MatchString(namespace) {
		return nil, false
	}
	// esbuild keeps comments on lines of their own: not code
	output = lineComments.ReplaceAll(output, nil)
	quoted := regexp.QuoteMeta(namespace)
	uses := regexp.MustCompile(`(?:^|[^\w$.])`+quoted+`(?:[^\w$]|$)`).FindAllIndex(output, -1)
	accesses := regexp.MustCompile(`(?:^|[^\w$.])`+quoted+`\.([A-Za-z_$][\w$]*)`).FindAllSubmatch(output, -1)
	// the import statement is the one use that is not an access
	if len(uses) != len(accesses)+1 {
		return nil, false
	}
	set := map[string]bool{}
	for _, access := range accesses {
		set[string(access[1])] = true
	}
	members := []string{}
	for member := range set {
		members = append(members, member)
	}
	sort.Strings(members)
	return members, true
}

// What the scan's output imports from each dependency: esbuild writes the
// imports of a bundle's externals with the names its modules use.
func parseDepUsage(output []byte, specs []string) depUsage {
	isSpec := map[string]bool{}
	for _, spec := range specs {
		isSpec[spec] = true
	}
	names := map[string]map[string]bool{}
	add := func(spec string, name string) {
		if !isSpec[spec] {
			return
		}
		if names[spec] == nil {
			names[spec] = map[string]bool{}
		}
		names[spec][name] = true
	}
	for _, match := range externalImportOrExport.FindAllSubmatch(output, -1) {
		keyword, clause, spec := string(match[1]), strings.TrimSpace(string(match[2])), string(match[3])
		if strings.HasPrefix(clause, "*") && keyword == "export" {
			add(spec, allExports)
			continue
		}
		if at := strings.Index(clause, "* as "); at >= 0 {
			if at > 0 {
				add(spec, "default") // import d, * as ns from
			}
			// a namespace only read as ns.name imports those names, as
			// esbuild tree-shakes it in a bundle
			namespace := strings.TrimSpace(clause[at+len("* as "):])
			members, ok := namespaceMembers(output, namespace)
			if !ok {
				add(spec, allExports)
				continue
			}
			if len(members) == 0 && names[spec] == nil && isSpec[spec] {
				names[spec] = map[string]bool{}
			}
			for _, member := range members {
				add(spec, member)
			}
			continue
		}
		if open := strings.Index(clause, "{"); open >= 0 {
			if open > 0 && keyword == "import" {
				add(spec, "default") // import d, { a } from
			}
			inner := strings.TrimSuffix(strings.TrimSpace(clause[open+1:]), "}")
			for _, item := range strings.Split(inner, ",") {
				item = strings.TrimSpace(item)
				if item == "" {
					continue
				}
				imported := strings.Trim(strings.Fields(item)[0], `"'`)
				add(spec, imported)
			}
			continue
		}
		if keyword == "import" && clause != "" {
			add(spec, "default")
			continue
		}
		add(spec, allExports)
	}
	for _, match := range externalSideEffect.FindAllSubmatch(output, -1) {
		if spec := string(match[1]); isSpec[spec] && names[spec] == nil {
			names[spec] = map[string]bool{}
		}
	}
	for _, match := range externalDynamic.FindAllSubmatch(output, -1) {
		add(string(match[1]), allExports)
	}

	usage := depUsage{}
	for _, spec := range specs {
		set, ok := names[spec]
		if !ok {
			// imported in a way the output does not show: the whole package
			usage[spec] = []string{allExports}
			continue
		}
		if set[allExports] {
			usage[spec] = []string{allExports}
			continue
		}
		list := []string{}
		for name := range set {
			list = append(list, name)
		}
		sort.Strings(list)
		usage[spec] = list
	}
	return usage
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

	// the build plugins resolve first, as in a bundle; scanning again
	// without them (they are gone), their imports stay empty
	if pluginCtx != nil {
		plugins, err := addContextBuildPluginsToBuildOptions(pluginCtx, &options)
		if err != nil {
			result.errors = []esbuild.Message{{Text: err.Error()}}
			return result
		}
		result.plugins = plugins
		result.pluginFilters = pluginFiltersOf(pluginCtx)
	} else {
		options.Plugins = append(options.Plugins, buildPluginFilters(state.pluginFilters)...)
	}

	mu := sync.Mutex{}
	specs := map[string]bool{}
	libs := map[string]bool{}
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
				// a url() of a stylesheet: the file's page path
				if args.Kind == esbuild.ResolveCSSURLToken && (imp.kind == importFile || imp.kind == importModule) {
					pageURL, _ := urlOf(state.root, imp.result.Path)
					return esbuild.OnResolveResult{Path: pageURL, External: true}, nil
				}
				switch imp.kind {
				case importDep:
					mu.Lock()
					specs[imp.value] = true
					mu.Unlock()
					return esbuild.OnResolveResult{Path: imp.value, External: true}, nil
				case importLib:
					mu.Lock()
					libs[imp.value] = true
					mu.Unlock()
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
	var script []byte
	for _, output := range built.OutputFiles {
		if strings.HasSuffix(output.Path, ".css") {
			result.style = output.Contents
		} else if strings.HasSuffix(output.Path, ".js") {
			script = output.Contents
		}
	}
	result.cssSources = map[string]bool{}

	sort.Strings(sources)
	for _, source := range sources {
		if path.Ext(source) == ".css" {
			if pageURL, ok := urlOf(state.root, source); ok {
				result.cssSources[pageURL] = true
			}
		}
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
	result.usage = parseDepUsage(script, result.specs)
	for lib := range libs {
		result.libs = append(result.libs, lib)
	}
	sort.Strings(result.libs)
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
	usage      depUsage
}

type depsManifest struct {
	Key        string            `json:"key"`
	Specs      []string          `json:"specs"`
	Urls       map[string]string `json:"urls"`
	Files      []string          `json:"files"`
	Css        []string          `json:"css"`
	LibImports []string          `json:"libImports"`
	Usage      depUsage          `json:"usage"`
}

const depsFacadeNamespace = "fullstacked-dep"

func depsCacheDir(root string) string {
	return filepath.Join(root, "node_modules", ".fullstacked", "deps")
}

// What the dependencies are built from: the packages installed, this core
// (its lib) and esbuild, the specifiers and the names imported from them.
func depsKey(root string, specs []string, usage depUsage) string {
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
		for _, name := range usageOf(usage, spec) {
			hash.Write([]byte{1})
			hash.Write([]byte(name))
		}
	}
	return hex.EncodeToString(hash.Sum(nil))
}

// the dependencies for specs: the current build when it has them, else the
// cache on disk, else a new build (written to the cache)
// the names imported from spec: all of it when unknown
func usageOf(usage depUsage, spec string) []string {
	if names, ok := usage[spec]; ok {
		return names
	}
	return []string{allExports}
}

func ensureDeps(root string, specs []string, usage depUsage, current *depsBuild) (*depsBuild, []esbuild.Message) {
	if len(specs) == 0 {
		return &depsBuild{urls: map[string]string{}, files: map[string][]byte{}, usage: depUsage{}}, nil
	}

	key := depsKey(root, specs, usage)
	if current != nil && current.key == key {
		return current, nil
	}

	if cached := readDepsCache(root, key); cached != nil {
		return cached, nil
	}

	build, errs := buildDeps(root, specs, usage, key)
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

func buildDeps(root string, specs []string, usage depUsage, key string) (*depsBuild, []esbuild.Message) {
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
					contents := depFacade(args.Path, usageOf(usage, args.Path))
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
		usage: depUsage{},
	}
	for _, spec := range specs {
		build.usage[spec] = usageOf(usage, spec)
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
//
// With the names the project imports, the facade imports only these: the
// package is tree-shaken as in a bundle (a large ESM package such as three
// keeps what the project uses).
func depFacade(spec string, names []string) string {
	if len(names) == 1 && names[0] == allExports {
		return "import * as ns from " + jsString(spec) + ";\n" + namespaceFacade("ns") + "export default target;\n"
	}
	out := ""
	if len(names) > 0 {
		specifiers := []string{}
		for i, name := range names {
			specifiers = append(specifiers, jsString(name)+" as __n"+itoa(i))
		}
		out += "import { " + strings.Join(specifiers, ", ") + " } from " + jsString(spec) + ";\n"
	} else {
		out += "import " + jsString(spec) + ";\n"
	}
	out += "const target = {};\n"
	for i, name := range names {
		out += "Object.defineProperty(target, " + jsString(name) + ", { get: () => __n" + itoa(i) + ", enumerable: true });\n"
	}
	out += "Object.defineProperty(target, \"__esModule\", { value: true });\nexport default target;\n"
	return out
}

// target: the namespace ns read live, marked __esModule
func namespaceFacade(ns string) string {
	return "const target = Object.create(Object.getPrototypeOf(" + ns + "));\n" +
		"for (const key of Object.getOwnPropertyNames(" + ns + ")) {\n" +
		"  if (key === \"__esModule\") continue;\n" +
		"  const desc = Object.getOwnPropertyDescriptor(" + ns + ", key);\n" +
		"  Object.defineProperty(target, key, { get: () => " + ns + "[key], enumerable: !desc || desc.enumerable });\n" +
		"}\n" +
		"Object.defineProperty(target, \"__esModule\", { value: true });\n"
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
		usage:      manifest.Usage,
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
		Usage:      build.usage,
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
