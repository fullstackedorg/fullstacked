package bundle

import (
	"bytes"
	"encoding/json"
	"fullstackedorg/fullstacked/internal/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"

	esbuild "github.com/evanw/esbuild/pkg/api"
	"golang.org/x/net/html"
)

// The runtime lib as ES modules, built once per core: one entry per lib
// module, split so the code they share (the bridge, events, buffer...) is one
// chunk, loaded once per page. A page's modules, its dependencies and the
// lib's own modules all import the same /@lib/ URLs: one bridge per page.
type libBuild struct {
	urls   map[string]string // module name (fs, fs/promises...) → page path
	files  map[string][]byte // page path → contents
	errors []esbuild.Message
}

var transformLib = sync.OnceValue(buildTransformLib)

func buildTransformLib() *libBuild {
	// one entry per file: several names share one (unavailable/index.ts)
	namesByFile := map[string][]string{}
	for name, file := range libModules {
		namesByFile[file] = append(namesByFile[file], name)
	}

	entries := []esbuild.EntryPoint{}
	outputOf := map[string]string{}
	for file, names := range namesByFile {
		sort.Strings(names)
		output := strings.TrimSuffix(strings.TrimPrefix(file, "/lib/"), path.Ext(file))
		outputOf[file] = output
		entries = append(entries, esbuild.EntryPoint{InputPath: names[0], OutputPath: output})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].OutputPath < entries[j].OutputPath })

	outdir := filepath.Join(os.TempDir(), "fullstacked-transform", "lib")
	result := esbuild.Build(esbuild.BuildOptions{
		EntryPointsAdvanced: entries,
		Bundle:              true,
		Splitting:           true,
		Format:              esbuild.FormatESModule,
		Write:               false,
		Outdir:              outdir,
		ChunkNames:          "_chunks/[name]-[hash]",
		Plugins:             esbuildPluginsLib,
	})

	build := &libBuild{
		urls:   map[string]string{},
		files:  map[string][]byte{},
		errors: result.Errors,
	}
	if len(result.Errors) > 0 {
		return build
	}

	for _, file := range result.OutputFiles {
		rel, err := filepath.Rel(outdir, file.Path)
		if err != nil {
			continue
		}
		build.files[transformLibPrefix+filepath.ToSlash(rel)] = file.Contents
	}
	for file, names := range namesByFile {
		for _, name := range names {
			build.urls[name] = transformLibPrefix + outputOf[file] + ".js"
		}
	}
	return build
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
			if !inside {
				return resolvedImport{}, []esbuild.Message{{Text: "Could not resolve \"" + args.Path + "\": it is outside of the project"}}
			}
			specifier = "." + pageURL
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
		if target.lib {
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
