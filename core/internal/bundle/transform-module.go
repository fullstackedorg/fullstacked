package bundle

import (
	"encoding/json"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	esbuild "github.com/evanw/esbuild/pkg/api"
)

// A module of the project, transformed on its own: esbuild builds the file
// alone, every import left external and rewritten to its page path. The
// project's tsconfig.json applies as in a bundle (esbuild reads it), and
// imports resolve as in a bundle (extensions, index files, tsconfig paths,
// package.json exports and browser fields).
type transformedModule struct {
	stamp    fileStamp
	contents []byte
}

// the module of file, transformed again when it changed since
func (state *transformState) module(file string) *transformedModule {
	stamp, _ := stampOf(file)
	for {
		if cached := state.cached(file, stamp); cached != nil {
			return cached
		}
		done, mine := state.claim(file)
		if !mine {
			<-done // transformed by prepare in the background
			continue
		}
		module := state.store(file, stamp, state.transform(file))
		state.release(file, done)
		return module
	}
}

// file's transform: done closes when it ends; mine when this caller does it
func (state *transformState) claim(file string) (done chan struct{}, mine bool) {
	key := state.moduleKey(file)
	state.modulesMu.Lock()
	defer state.modulesMu.Unlock()
	if done, ok := state.inflight[key]; ok {
		return done, false
	}
	done = make(chan struct{})
	state.inflight[key] = done
	return done, true
}

func (state *transformState) release(file string, done chan struct{}) {
	key := state.moduleKey(file)
	state.modulesMu.Lock()
	delete(state.inflight, key)
	state.modulesMu.Unlock()
	close(done)
}

// prepare transforms the modules it found ahead of the page, state.mu held:
// with the dependencies it just built, which have every package they import
func (state *transformState) pretransform(file string, deps *depsBuild, filters []pluginFilter) {
	stamp, _ := stampOf(file)
	if state.cached(file, stamp) != nil {
		return
	}
	done, mine := state.claim(file)
	if !mine {
		return
	}
	defer state.release(file, done)
	contents, missing, errs := state.transformWith(file, deps, filters)
	if len(missing) > 0 {
		// left to the page's request, which builds the dependencies again
		return
	}
	if len(errs) > 0 {
		contents = errorModule(file, errs)
	}
	state.store(file, stamp, contents)
}

// modules are cached by page path: the page asks for a file through the
// root it was given, the scan found it through its real path (a symlink)
func (state *transformState) moduleKey(file string) string {
	if pageURL, ok := urlOf(state.root, file); ok {
		return pageURL
	}
	return file
}

func (state *transformState) cached(file string, stamp fileStamp) *transformedModule {
	state.modulesMu.Lock()
	defer state.modulesMu.Unlock()
	cached, ok := state.modules[state.moduleKey(file)]
	if ok && cached.stamp == stamp {
		return cached
	}
	return nil
}

func (state *transformState) store(file string, stamp fileStamp, contents []byte) *transformedModule {
	module := &transformedModule{stamp: stamp, contents: contents}
	state.modulesMu.Lock()
	state.modules[state.moduleKey(file)] = module
	state.modulesMu.Unlock()
	return module
}

func (state *transformState) transform(file string) []byte {
	state.mu.Lock()
	deps := state.deps
	filters := state.pluginFilters
	state.mu.Unlock()

	contents, missing, errs := state.transformWith(file, deps, filters)
	if len(missing) > 0 {
		// a package no module imported until now (a file edited since the
		// scan): the dependencies are built again with it
		state.mu.Lock()
		// what the scan saw of the others stays, the new ones are whole
		specs := append([]string{}, missing...)
		usage := depUsage{}
		if state.deps != nil {
			specs = append(specs, state.deps.specs...)
			for spec, names := range state.deps.usage {
				usage[spec] = names
			}
		}
		specs = uniqueSorted(specs)
		rebuilt, depsErrs := ensureDeps(state.root, specs, usage, state.deps)
		if len(depsErrs) == 0 {
			state.deps = rebuilt
		}
		deps = state.deps
		state.mu.Unlock()
		if len(depsErrs) > 0 {
			return errorModule(file, depsErrs)
		}
		contents, _, errs = state.transformWith(file, deps, filters)
	}

	if len(errs) > 0 {
		return errorModule(file, errs)
	}
	return contents
}

func uniqueSorted(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	sort.Strings(out)
	return out
}

func (state *transformState) transformWith(file string, deps *depsBuild, filters []pluginFilter) ([]byte, []string, []esbuild.Message) {
	missingMu := sync.Mutex{}
	missing := []string{}

	options := esbuild.BuildOptions{
		EntryPoints:   []string{file},
		Bundle:        true,
		Format:        esbuild.FormatESModule,
		Write:         false,
		AbsWorkingDir: state.root,
		Outdir:        filepath.Join(state.root, "out"),
		Sourcemap:     esbuild.SourceMapInline,
		Plugins:       buildPluginFilters(filters),
	}

	options.Plugins = append(options.Plugins, esbuild.Plugin{
		Name: "fullstacked-transform",
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
				case importLib:
					return libImportResult(imp.value, args.Kind), nil
				case importDep:
					url := ""
					if deps != nil {
						url = deps.urls[imp.value]
					}
					if url == "" {
						missingMu.Lock()
						missing = append(missing, imp.value)
						missingMu.Unlock()
						return esbuild.OnResolveResult{Path: imp.value, External: true}, nil
					}
					return proxyResult("dep:"+imp.value, proxyTarget{url: url}), nil
				case importModule, importFile:
					return esbuild.OnResolveResult{Path: imp.value, External: true}, nil
				}
				return imp.result, nil
			})
			addProxies(build)
		},
	})

	result := esbuild.Build(options)
	if len(result.Errors) > 0 {
		return nil, nil, result.Errors
	}
	if len(missing) > 0 {
		return nil, uniqueSorted(missing), nil
	}
	for _, output := range result.OutputFiles {
		if strings.HasSuffix(output.Path, ".js") {
			return output.Contents, nil, nil
		}
	}
	return []byte{}, nil, nil
}

// the imports a build plugin takes are empty modules, as in a bundle: the
// plugin's outputs are linked in the page instead
func buildPluginFilters(filters []pluginFilter) []esbuild.Plugin {
	plugins := []esbuild.Plugin{}
	for _, filter := range filters {
		filter := filter
		namespace := "build-plugin-" + filter.name
		plugins = append(plugins, esbuild.Plugin{
			Name: filter.name,
			Setup: func(build esbuild.PluginBuild) {
				build.OnResolve(esbuild.OnResolveOptions{Filter: filter.data.Filter}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
					if filter.data.Ext != nil {
						included := false
						for _, ext := range *filter.data.Ext {
							if strings.HasSuffix(args.Importer, ext) {
								included = true
								break
							}
						}
						if !included {
							return esbuild.OnResolveResult{}, nil
						}
					}
					return esbuild.OnResolveResult{Path: args.Path, Namespace: namespace}, nil
				})
				empty := ""
				build.OnLoad(esbuild.OnLoadOptions{Filter: ".*", Namespace: namespace}, func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
					return esbuild.OnLoadResult{Loader: esbuild.LoaderEmpty, Contents: &empty}, nil
				})
			},
		})
	}
	return plugins
}

type overlayMessage struct {
	Text     string `json:"text"`
	Location string `json:"location,omitempty"`
	LineText string `json:"lineText,omitempty"`
}

// A module that failed to transform (a file edited while the project runs):
// it logs the errors and shows them over the page instead of a blank page.
func errorModule(file string, messages []esbuild.Message) []byte {
	list := []overlayMessage{}
	for _, msg := range messages {
		m := overlayMessage{Text: msg.Text}
		if msg.Location != nil {
			m.Location = msg.Location.File + ":" + itoa(msg.Location.Line) + ":" + itoa(msg.Location.Column)
			m.LineText = msg.Location.LineText
		}
		list = append(list, m)
	}
	data, _ := json.Marshal(list)
	return []byte("const errors = " + string(data) + ";\n" + errorOverlayScript)
}

const errorOverlayScript = `const text = errors.map((e) => "[ERROR] " + e.text + (e.location ? "\n  at " + e.location : "") + (e.lineText ? "\n    " + e.lineText : "")).join("\n\n");
console.error(text);
const show = () => {
  let overlay = document.getElementById("fullstacked-error-overlay");
  if (!overlay) {
    overlay = document.createElement("pre");
    overlay.id = "fullstacked-error-overlay";
    overlay.style.cssText = "position:fixed;inset:0;margin:0;padding:16px;overflow:auto;z-index:2147483647;background:rgba(20,20,20,0.95);color:#ff8080;font:13px/1.4 monospace;white-space:pre-wrap";
    document.documentElement.append(overlay);
  }
  overlay.textContent += (overlay.textContent ? "\n\n" : "") + text;
};
if (typeof document !== "undefined") {
  if (document.body) show(); else addEventListener("DOMContentLoaded", show);
}
throw new Error(errors[0] ? errors[0].text : "Transform failed");
`

// A stylesheet of the project, bundled: its @imports inline, the imports a
// build plugin takes empty (the plugin's output is linked in the page), and
// its url()s left to the page, at the files' page paths.
func cssBundle(root string, file string, filters []pluginFilter) []byte {
	options := esbuild.BuildOptions{
		EntryPoints:   []string{file},
		Bundle:        true,
		Write:         false,
		AbsWorkingDir: root,
		Outdir:        filepath.Join(root, "out"),
		Plugins:       buildPluginFilters(filters),
	}
	options.Plugins = append(options.Plugins, esbuild.Plugin{
		Name: "fullstacked-css",
		Setup: func(build esbuild.PluginBuild) {
			build.OnResolve(esbuild.OnResolveOptions{Filter: ".*"}, func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
				if args.Kind != esbuild.ResolveCSSURLToken || isGuarded(args) || args.Namespace != "file" {
					return esbuild.OnResolveResult{}, nil
				}
				if strings.HasPrefix(args.Path, "data:") || strings.HasPrefix(args.Path, "#") || strings.Contains(args.Path, "://") {
					return esbuild.OnResolveResult{Path: args.Path, External: true}, nil
				}
				resolved := build.Resolve(args.Path, esbuild.ResolveOptions{
					Importer:   args.Importer,
					ResolveDir: args.ResolveDir,
					Kind:       args.Kind,
					PluginData: guard,
				})
				if len(resolved.Errors) > 0 {
					return esbuild.OnResolveResult{Errors: resolved.Errors}, nil
				}
				pageURL, inside := urlOf(root, resolved.Path)
				if !inside {
					return esbuild.OnResolveResult{Errors: []esbuild.Message{{Text: "Could not resolve \"" + args.Path + "\": it is outside of the project"}}}, nil
				}
				return esbuild.OnResolveResult{Path: pageURL, External: true}, nil
			})
		},
	})

	result := esbuild.Build(options)
	if len(result.Errors) > 0 {
		text := ""
		for _, msg := range result.Errors {
			text += formatMessage(msg) + "\n"
		}
		return []byte("/* " + strings.ReplaceAll(text, "*/", "* /") + " */\n")
	}
	for _, output := range result.OutputFiles {
		if strings.HasSuffix(output.Path, ".css") {
			return output.Contents
		}
	}
	return []byte{}
}

// The modules a page of the project loads: the lib's prelude, the lib
// modules (and their chunks) its modules and dependencies import, every file
// of the dependencies and every module of the project, by page path.
// state.mu held.
func (state *transformState) modulePreloads() []string {
	lib := transformLib()
	seen := map[string]bool{}
	preloads := []string{}

	var addLib func(pagePath string)
	addLib = func(pagePath string) {
		if seen[pagePath] {
			return
		}
		if _, ok := lib.files[pagePath]; !ok {
			return
		}
		seen[pagePath] = true
		preloads = append(preloads, pagePath)
		for _, imp := range lib.imports[pagePath] {
			addLib(imp)
		}
	}

	addLib(lib.urls["fullstacked"])
	if state.deps != nil {
		for _, imp := range state.deps.libImports {
			addLib(imp)
		}
		paths := []string{}
		for pagePath := range state.deps.files {
			if strings.HasSuffix(pagePath, ".js") {
				paths = append(paths, pagePath)
			}
		}
		sort.Strings(paths)
		preloads = append(preloads, paths...)
	}

	for _, name := range state.libImports {
		addLib(lib.urls[name])
	}

	files := []string{}
	for file := range state.sources {
		if transformModuleExtensions[path.Ext(file)] {
			files = append(files, file)
		}
	}
	sort.Strings(files)
	for _, file := range files {
		if pageURL, ok := urlOf(state.root, file); ok {
			preloads = append(preloads, pageURL)
		}
	}
	return preloads
}
