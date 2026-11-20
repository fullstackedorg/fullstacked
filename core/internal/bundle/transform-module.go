package bundle

import (
	"encoding/json"
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
	if cached := state.cached(file, stamp); cached != nil {
		return cached
	}
	return state.store(file, stamp, state.transform(file))
}

// prepare transforms the modules it found ahead of the page, state.mu held:
// with the dependencies it just built, which have every package they import
func (state *transformState) pretransform(file string, deps *depsBuild, filters []pluginFilter) {
	stamp, _ := stampOf(file)
	if state.cached(file, stamp) != nil {
		return
	}
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

func (state *transformState) cached(file string, stamp fileStamp) *transformedModule {
	state.modulesMu.Lock()
	defer state.modulesMu.Unlock()
	cached, ok := state.modules[file]
	if ok && cached.stamp == stamp {
		return cached
	}
	return nil
}

func (state *transformState) store(file string, stamp fileStamp, contents []byte) *transformedModule {
	module := &transformedModule{stamp: stamp, contents: contents}
	state.modulesMu.Lock()
	state.modules[file] = module
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
		specs := append([]string{}, missing...)
		if state.deps != nil {
			specs = append(specs, state.deps.specs...)
		}
		specs = uniqueSorted(specs)
		rebuilt, depsErrs := ensureDeps(state.root, specs, state.deps)
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
