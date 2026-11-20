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
	"fmt"
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

// the project's stylesheets, bundled in import order: a bundle's index.css
const TransformStylePath = "/@fullstacked/style.css"

// a worker of a page in transform mode (worker_threads): the lib's
// prelude, then the worker's module, /@fullstacked/worker/<path>
const TransformWorkerPrefix = "/@fullstacked/worker/"

const (
	transformLibPrefix    = "/@lib/"
	transformDepsPrefix   = "/@deps/"
	transformPluginPrefix = "/@plugin/"
	transformImportPrefix = "/@import/"
	transformCSSPrefix    = "/@css/"
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

	// the modules the page will load, preloaded by its HTML
	preloads []string

	// the project's stylesheets (scanResult.style), linked by the page
	style      []byte
	cssSources map[string]bool

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

// The real path of a project directory: esbuild resolves imports to real
// paths (/tmp is /private/tmp on macOS), the containment checks compare
// them with it.
func canonicalRoot(root string) string {
	real, err := filepath.EvalSymlinks(root)
	if err != nil {
		return filepath.Clean(root)
	}
	return real
}

// One state per project: keyed by its real path, so a context that names
// it through a symlink (/data/data is /data/user/0 on Android) finds it. Its
// root stays the path it was first given, as a bundle uses it: the paths
// build plugins get are the ones they would get from a bundle.
func transformStateFor(root string) *transformState {
	root = filepath.Clean(root)
	key := canonicalRoot(root)
	transformStatesMu.Lock()
	defer transformStatesMu.Unlock()
	state, ok := transformStates[key]
	if !ok {
		state = &transformState{
			root:    root,
			modules: map[string]*transformedModule{},
		}
		transformStates[key] = state
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

// FULLSTACKED_TRANSFORM_TRACE=1 prints how long each step of a prepare took
var transformTrace = os.Getenv("FULLSTACKED_TRANSFORM_TRACE") != ""

func traceStep(name string, start time.Time) time.Time {
	now := time.Now()
	if transformTrace {
		fmt.Fprintf(os.Stderr, "[transform] %s %.1fms\n", name, float64(now.Sub(start).Microseconds())/1000)
	}
	return now
}

// state.mu is held
func (state *transformState) prepare(pluginCtx *types.Context, entry string) EsbuildResult {
	state.entry = entry
	state.prepared = true

	step := time.Now()
	lib := transformLib()
	step = traceStep("lib", step)
	if len(lib.errors) > 0 {
		state.result = EsbuildResult{Errors: lib.errors}
		return state.result
	}

	scan := state.scan(pluginCtx)
	step = traceStep("scan", step)
	state.result = EsbuildResult{Errors: scan.errors, Warnings: scan.warnings, OutputFiles: []string{}}
	if len(scan.errors) > 0 {
		return state.result
	}
	state.sources = scan.sources
	state.style = scan.style
	state.cssSources = scan.cssSources

	deps, depsErrors := ensureDeps(state.root, scan.specs, state.deps)
	if len(depsErrors) > 0 {
		state.result.Errors = depsErrors
		return state.result
	}
	state.deps = deps
	step = traceStep("deps", step)

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

	step = traceStep("plugins", step)
	state.transformAll()
	state.preloads = state.modulePreloads()
	traceStep("modules", step)
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
	state := transformStateFor(ctx.Directories.Root)
	root := state.root

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
	case TransformStylePath:
		state.mu.Lock()
		style := state.style
		state.mu.Unlock()
		return "text/css", append([]byte{}, style...), true
	}

	if strings.HasPrefix(pathname, TransformWorkerPrefix) {
		modulePath := "/" + strings.TrimPrefix(pathname, TransformWorkerPrefix)
		file, ok := insideRoot(root, modulePath)
		if !ok || !fs.ExistsFn(file) {
			return "", nil, false
		}
		moduleURL, _ := urlOf(root, file)
		return "text/javascript", preludeModule(moduleURL), true
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

	if strings.HasPrefix(pathname, transformCSSPrefix) {
		file, ok := insideRoot(root, strings.TrimPrefix(pathname, transformCSSPrefix))
		if !ok || !fs.ExistsFn(file) {
			return "", nil, false
		}
		state.mu.Lock()
		filters := state.pluginFilters
		state.mu.Unlock()
		return "text/css", cssBundle(root, file, filters), true
	}

	if strings.HasPrefix(pathname, transformImportPrefix) {
		file, ok := insideRoot(root, strings.TrimPrefix(pathname, transformImportPrefix))
		if !ok || !fs.ExistsFn(file) {
			return "", nil, false
		}
		// a stylesheet the scan bundled is already in the page's style.css
		state.mu.Lock()
		pageURL, _ := urlOf(root, file)
		inStyle := state.cssSources[pageURL]
		state.mu.Unlock()
		if inStyle {
			return "text/javascript", []byte("export default " + jsString(pageURL) + ";\n"), true
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

// the page path of a file of the project, escaped for an import specifier.
// esbuild resolves files to their real path: a root reached through a
// symlink (/tmp on macOS) is also compared by its real path.
func urlOf(root string, file string) (string, bool) {
	rel, ok := relInside(root, file)
	if !ok {
		rel, ok = relInside(cachedCanonicalRoot(root), file)
	}
	if !ok {
		return "", false
	}
	return (&url.URL{Path: "/" + filepath.ToSlash(rel)}).EscapedPath(), true
}

func relInside(root string, file string) (string, bool) {
	rel, err := filepath.Rel(root, file)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}
	return rel, true
}

var canonicalRoots sync.Map

// canonicalRoot, cached: urlOf asks for every import outside the root
func cachedCanonicalRoot(root string) string {
	if real, ok := canonicalRoots.Load(root); ok {
		return real.(string)
	}
	real := canonicalRoot(root)
	canonicalRoots.Store(root, real)
	return real
}

// The lib's prelude initializes the bridge with a top-level await: a sibling
// import would run before it finished. A module runs once its imports did,
// so the project's entry is imported from the body.
func (state *transformState) entryModule() []byte {
	entryURL, _ := urlOf(state.root, state.entry)
	return preludeModule(entryURL)
}

// globalThis.fullstacked.transform tells the lib the page runs in transform
// mode (worker_threads then wraps its workers' modules the same way)
func preludeModule(moduleURL string) []byte {
	lib := transformLib()
	return []byte("import " + jsString(lib.urls["fullstacked"]) + ";\n" +
		"globalThis.fullstacked.transform = true;\n" +
		"await import(" + jsString(moduleURL) + ");\n")
}

func (state *transformState) html() []byte {
	state.mu.Lock()
	result := state.result
	deps := state.deps
	pluginAssets := state.pluginAssets
	preloads := state.preloads
	style := state.style
	state.mu.Unlock()

	if len(result.Errors) > 0 {
		return errorPage(result.Errors)
	}

	assets := []string{}
	if deps != nil {
		assets = append(assets, deps.css...)
	}
	if len(style) > 0 {
		assets = append(assets, TransformStylePath)
	}
	assets = append(assets, TransformEntryPath)

	doc, err := htmlWithAssets(assets)
	if err != nil {
		return nil
	}
	// every module the page will import, asked for at once instead of
	// one level of imports after the other
	for _, preload := range preloads {
		doc.addInHead(`<link rel="modulepreload" href="` + preload + `" />`)
	}
	// the plugins' outputs come after the project's stylesheets, as in a
	// bundle's index.html: a stylesheet a module imports goes before them
	for _, asset := range pluginAssets {
		switch path.Ext(asset) {
		case ".css":
			doc.addInHead(`<link rel="stylesheet" href="` + asset + `" data-fullstacked-plugin="" />`)
		case ".js":
			doc.addInBody(`<script src="` + asset + `" type="module"></script>`)
		}
	}
	return renderDoc(doc)
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
