package bundle

// Transform mode (docs/architecture.md#transform-mode): a context's page is
// served from the project's sources instead of from out/.
//
//	GET /                       generated index.html
//	GET /@fullstacked/entry.js  imports the lib's prelude, then the project's entry
//	GET /@lib/<module>.js       the runtime lib, built once per core (transform-lib.go)
//	GET /@deps/<package>.js     the npm dependencies, built once per lockfile (transform-deps.go)
//	GET /@plugin/<name>/<file>  the outputs of the build plugins
//	GET /@import/<path>         a CSS, JSON or asset file imported by a module
//	GET /<path>.ts(x)           a project module, transformed on request (transform-module.go)
//
// Prepare runs before the page opens: it scans the project from its entry
// (the scan's errors are the check a bundle did), builds the dependencies,
// runs the build plugins and transforms every module it found, so the page's
// requests are answered from memory.

import (
	"errors"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/internal/plugin"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"mime"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	esbuild "github.com/evanw/esbuild/pkg/api"
)

// the module the generated page loads: the lib's prelude, then the entry
const TransformEntryPath = "/@fullstacked/entry.js"

const (
	transformLibPrefix    = "/@lib/"
	transformDepsPrefix   = "/@deps/"
	transformPluginPrefix = "/@plugin/"
	transformImportPrefix = "/@import/"
)

// the extensions of the files served as modules
var transformModuleExtensions = map[string]bool{
	".ts": true, ".tsx": true, ".mts": true, ".cts": true,
	".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
}

// the state of one project in transform mode, shared by every context that
// runs it (keyed by its directory)
type transformState struct {
	// one prepare at a time, and the dependencies they build
	mu sync.Mutex

	root  string
	entry string // absolute path of the entry point

	prepared bool
	result   EsbuildResult // the last prepare's errors and warnings

	// the project files the scan loaded, to tell when to scan again
	sources map[string]fileStamp

	deps *depsBuild

	// the build plugins' filters, their imports are empty modules, and the
	// context that registered them
	pluginFilters []pluginFilter
	pluginCtx     uint8
	pluginOutputs map[string][]byte // /@plugin/<name>/<file>
	pluginAssets  []string          // in the order a bundle's index.html links them

	modulesMu sync.Mutex
	modules   map[string]*transformedModule
}

type fileStamp struct {
	modTime time.Time
	size    int64
}

type pluginFilter struct {
	name string
	data PluginBuildData
}

var (
	transformStatesMu sync.Mutex
	transformStates   = map[string]*transformState{}
)

func transformStateFor(root string) *transformState {
	transformStatesMu.Lock()
	defer transformStatesMu.Unlock()
	state, ok := transformStates[root]
	if !ok {
		state = &transformState{
			root:    root,
			modules: map[string]*transformedModule{},
		}
		transformStates[root] = state
	}
	return state
}

func stampOf(file string) (fileStamp, bool) {
	info, err := os.Stat(file)
	if err != nil {
		return fileStamp{}, false
	}
	return fileStamp{modTime: info.ModTime(), size: info.Size()}, true
}

func errorResult(err error) EsbuildResult {
	return EsbuildResult{Errors: []esbuild.Message{{Text: err.Error()}}}
}

// TransformRoot is the project directory of an entry point (a directory or a
// file in it) and its entry file, the project runs in transform mode from.
func TransformRoot(entryPoint string) (root string, entry string, err error) {
	stats, err := fs.StatsFn(entryPoint)
	if err != nil {
		return "", "", errors.New("entry point not found")
	}
	if stats.IsDir {
		entry, err = findEntryPointInDir(entryPoint)
		if err != nil {
			return "", "", err
		}
		return filepath.Clean(entryPoint), entry, nil
	}
	return filepath.Dir(entryPoint), entryPoint, nil
}

// PrepareTransformFn scans the project of entryPoint, builds its
// dependencies, runs the build plugins registered in ctx and transforms its
// modules. Its errors are the ones a bundle would report.
func PrepareTransformFn(ctx *types.Context, entryPoint string) EsbuildResult {
	root, entry, err := TransformRoot(entryPoint)
	if err != nil {
		return errorResult(err)
	}

	state := transformStateFor(root)
	state.mu.Lock()
	defer state.mu.Unlock()

	var pluginCtx *types.Context
	if ctx != nil {
		pluginCtx = ctx
	}
	return state.prepare(pluginCtx, entry)
}

// state.mu is held
func (state *transformState) prepare(pluginCtx *types.Context, entry string) EsbuildResult {
	state.entry = entry
	state.prepared = true

	lib := transformLib()
	if len(lib.errors) > 0 {
		state.result = EsbuildResult{Errors: lib.errors}
		return state.result
	}

	scan := state.scan(pluginCtx)
	state.result = EsbuildResult{Errors: scan.errors, Warnings: scan.warnings, OutputFiles: []string{}}
	if len(scan.errors) > 0 {
		return state.result
	}
	state.sources = scan.sources

	deps, depsErrors := ensureDeps(state.root, scan.specs, state.deps)
	if len(depsErrors) > 0 {
		state.result.Errors = depsErrors
		return state.result
	}
	state.deps = deps

	if pluginCtx != nil {
		state.pluginCtx = pluginCtx.Id
		state.pluginFilters = scan.pluginFilters
		outputs, assets, err := runTransformPlugins(pluginCtx, scan)
		if err != nil {
			state.result.Errors = []esbuild.Message{*err}
			return state.result
		}
		state.pluginOutputs = outputs
		state.pluginAssets = assets
	}

	state.transformAll()
	return state.result
}

// The page asks again (a reload): the project scans again when one of its
// files changed since, with the build plugins of the context that prepared
// it, if it still runs.
func (state *transformState) refresh() {
	state.mu.Lock()
	defer state.mu.Unlock()

	if !state.prepared {
		state.prepare(nil, state.entry)
		return
	}

	if !state.changed() {
		return
	}

	var pluginCtx *types.Context
	if len(state.pluginFilters) > 0 {
		if ctx, ok := store.GetContext(state.pluginCtx); ok && !ctx.Exited {
			pluginCtx = ctx
		}
	}
	filters, outputs, assets := state.pluginFilters, state.pluginOutputs, state.pluginAssets
	state.prepare(pluginCtx, state.entry)
	if pluginCtx == nil {
		// the plugins are gone: their last outputs stay
		state.pluginFilters, state.pluginOutputs, state.pluginAssets = filters, outputs, assets
	}
}

func (state *transformState) changed() bool {
	for file, stamp := range state.sources {
		current, ok := stampOf(file)
		if !ok || current != stamp {
			return true
		}
	}
	return false
}

// transforms every module the scan found, in parallel, so the page's
// requests are memory reads
func (state *transformState) transformAll() {
	files := []string{}
	for file := range state.sources {
		if transformModuleExtensions[path.Ext(file)] {
			files = append(files, file)
		}
	}

	work := make(chan string)
	wg := sync.WaitGroup{}
	for i := 0; i < runtime.NumCPU(); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for file := range work {
				state.pretransform(file, state.deps, state.pluginFilters)
			}
		}()
	}
	for _, file := range files {
		work <- file
	}
	close(work)
	wg.Wait()
}

// ServeTransform answers a request of a page in transform mode. False when
// the path is not one of transform mode's: the router serves it as a static
// file of the project.
func ServeTransform(ctx *types.Context, pathname string) (mimeType string, contents []byte, handled bool) {
	root := ctx.Directories.Root
	state := transformStateFor(root)

	switch pathname {
	case "/", "/index.html":
		if state.entry == "" {
			_, entry, err := TransformRoot(root)
			if err != nil {
				return "", nil, false
			}
			state.mu.Lock()
			state.entry = entry
			state.mu.Unlock()
		}
		state.refresh()
		return "text/html", state.html(), true
	case TransformEntryPath:
		return "text/javascript", state.entryModule(), true
	}

	if strings.HasPrefix(pathname, transformLibPrefix) {
		contents, ok := transformLib().files[pathname]
		return mimeOf(pathname), contents, ok
	}

	if strings.HasPrefix(pathname, transformDepsPrefix) {
		state.mu.Lock()
		deps := state.deps
		state.mu.Unlock()
		if deps == nil {
			return "", nil, false
		}
		contents, ok := deps.files[pathname]
		return mimeOf(pathname), contents, ok
	}

	if strings.HasPrefix(pathname, transformPluginPrefix) {
		state.mu.Lock()
		contents, ok := state.pluginOutputs[pathname]
		state.mu.Unlock()
		return mimeOf(pathname), contents, ok
	}

	if strings.HasPrefix(pathname, transformImportPrefix) {
		file, ok := insideRoot(root, strings.TrimPrefix(pathname, transformImportPrefix))
		if !ok || !fs.ExistsFn(file) {
			return "", nil, false
		}
		return "text/javascript", importedFileModule(root, file), true
	}

	if transformModuleExtensions[path.Ext(pathname)] {
		file, ok := insideRoot(root, pathname)
		if !ok {
			return "", nil, false
		}
		stats, err := fs.StatsFn(file)
		if err != nil || stats.IsDir {
			return "", nil, false
		}
		return "text/javascript", state.module(file).contents, true
	}

	return "", nil, false
}

func mimeOf(pathname string) string {
	ext := path.Ext(pathname)
	switch ext {
	case ".js", ".mjs":
		return "text/javascript"
	case ".css":
		return "text/css"
	}
	mimeType := mime.TypeByExtension(ext)
	if mimeType == "" {
		return "application/octet-stream"
	}
	return mimeType
}

// the file of a page path, false when it is outside of root (../ in any form)
func insideRoot(root string, pathname string) (string, bool) {
	pathname, err := url.PathUnescape(pathname)
	if err != nil {
		return "", false
	}
	pathname = strings.Trim(strings.ReplaceAll(pathname, "\\", "/"), "/")
	if filepath.VolumeName(pathname) != "" {
		return "", false
	}
	joined := filepath.Clean(filepath.Join(root, filepath.FromSlash(pathname)))
	rel, err := filepath.Rel(root, joined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return joined, true
}

// the page path of a file of the project, escaped for an import specifier
func urlOf(root string, file string) (string, bool) {
	rel, err := filepath.Rel(root, file)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return (&url.URL{Path: "/" + filepath.ToSlash(rel)}).EscapedPath(), true
}

// The lib's prelude initializes the bridge with a top-level await: a sibling
// import would run before it finished. A module runs once its imports did,
// so the project's entry is imported from the body.
func (state *transformState) entryModule() []byte {
	lib := transformLib()
	entryURL, _ := urlOf(state.root, state.entry)
	return []byte("import " + jsString(lib.urls["fullstacked"]) + ";\nawait import(" + jsString(entryURL) + ");\n")
}

func (state *transformState) html() []byte {
	state.mu.Lock()
	result := state.result
	deps := state.deps
	pluginAssets := state.pluginAssets
	state.mu.Unlock()

	if len(result.Errors) > 0 {
		return errorPage(result.Errors)
	}

	assets := []string{}
	if deps != nil {
		assets = append(assets, deps.css...)
	}
	assets = append(assets, TransformEntryPath)
	assets = append(assets, pluginAssets...)

	html, _ := generateIndexHTML(assets)
	return html
}

// what a page shows when the project could not be prepared
func errorPage(messages []esbuild.Message) []byte {
	doc, err := newDoc()
	if err != nil {
		return nil
	}
	text := ""
	for _, msg := range messages {
		text += formatMessage(msg) + "\n"
	}
	doc.addInBody(`<pre style="white-space:pre-wrap;color:#b00020;font-family:monospace;padding:16px"></pre>`)
	pre := doc.body.LastChild
	pre.AppendChild(textNode(text))
	return renderDoc(doc)
}

func formatMessage(msg esbuild.Message) string {
	out := "[ERROR] " + msg.Text
	if msg.Location != nil {
		out += "\n  at " + msg.Location.File + ":" + itoa(msg.Location.Line) + ":" + itoa(msg.Location.Column)
		if msg.Location.LineText != "" {
			out += "\n    " + msg.Location.LineText
		}
	}
	return out
}

// the plugins' outputs, by page path, and the ones index.html links
func runTransformPlugins(ctx *types.Context, scan scanResult) (map[string][]byte, []string, *esbuild.Message) {
	outputs := map[string][]byte{}
	assets := []string{}
	plugins := []*types.ContextPlugin{}
	for p := range scan.plugins {
		plugins = append(plugins, p)
	}
	sort.Slice(plugins, func(i, j int) bool { return plugins[i].Id < plugins[j].Id })
	for _, p := range plugins {
		params := scan.plugins[p]
		if len(params.Resolved) == 0 {
			continue
		}
		params.Sources = scan.sourcesRelative
		response, err := plugin.Call(ctx, p.Id, []types.SerializableData{params})
		if err != nil {
			return nil, nil, &esbuild.Message{PluginName: p.Name, Text: err.Error()}
		}
		for i := 0; i+1 < len(response); i += 2 {
			outputName, _ := response[i].Data.(string)
			contents, _ := response[i+1].Data.([]byte)
			pagePath := transformPluginPrefix + url.PathEscape(p.Name) + "/" + strings.TrimLeft(filepath.ToSlash(outputName), "/")
			outputs[pagePath] = contents
			assets = append(assets, pagePath)
		}
	}
	return outputs, assets, nil
}
