package bundle

import (
	"fullstackedorg/fullstacked/types"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// a project with a few packages of each kind, written for each test
func writeProject(t *testing.T, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	defaults := map[string]string{
		"package.json":                          `{"name":"fixture","private":true}`,
		"node_modules/cjs-fn/package.json":      `{"name":"cjs-fn","main":"index.js"}`,
		"node_modules/cjs-fn/index.js":          `module.exports = function cjsFn() { return "fn"; }; module.exports.extra = 1;`,
		"node_modules/cjs-obj/package.json":     `{"name":"cjs-obj","main":"index.js"}`,
		"node_modules/cjs-obj/index.js":         `exports.a = 1; exports.events = require("events");`,
		"node_modules/esm-only/package.json":    `{"name":"esm-only","type":"module","exports":{".":{"import":"./index.js"},"./sub":{"import":"./sub.js"}}}`,
		"node_modules/esm-only/index.js":        `export const named = "esm"; export default "esm-default";`,
		"node_modules/esm-only/sub.js":          `export const sub = "sub";`,
		"node_modules/browser-pkg/package.json": `{"name":"browser-pkg","main":"node.js","browser":"browser.js"}`,
		"node_modules/browser-pkg/node.js":      `module.exports = "node";`,
		"node_modules/browser-pkg/browser.js":   `module.exports = "browser";`,
		"node_modules/with-css/package.json":    `{"name":"with-css","main":"index.js"}`,
		"node_modules/with-css/index.js":        `import "./style.css"; export const x = 1;`,
		"node_modules/with-css/style.css":       `.with-css { color: red; }`,
	}
	for name, contents := range defaults {
		if _, ok := files[name]; !ok {
			files[name] = contents
		}
	}
	for name, contents := range files {
		file := filepath.Join(root, filepath.FromSlash(name))
		os.MkdirAll(filepath.Dir(file), 0755)
		if err := os.WriteFile(file, []byte(contents), 0644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func transformCtx(root string) *types.Context {
	return &types.Context{Id: 200, Directories: types.ContextDirectories{Root: root, Build: filepath.Join(root, "out")}, Transform: true}
}

func serve(t *testing.T, root string, pathname string) string {
	t.Helper()
	_, contents, handled := ServeTransform(transformCtx(root), pathname)
	if !handled || contents == nil {
		t.Fatalf("%s not served", pathname)
	}
	return string(contents)
}

func prepareOK(t *testing.T, root string) {
	t.Helper()
	result := PrepareTransformFn(nil, root)
	if len(result.Errors) > 0 {
		t.Fatalf("prepare: %+v", result.Errors)
	}
}

var bridgeInit = regexp.MustCompile(`await shared\w*\("init", init\w*\)`)

func TestTransformLibBuild(t *testing.T) {
	lib := transformLib()
	if len(lib.errors) > 0 {
		t.Fatalf("%+v", lib.errors)
	}
	for name := range libModules {
		url, ok := lib.urls[name]
		if !ok {
			t.Fatalf("no url for %s", name)
		}
		if _, ok := lib.files[url]; !ok {
			t.Fatalf("no file for %s at %s", name, url)
		}
	}
	// the bridge is one module of the page: its code is in one file, every
	// lib module imports it from there
	defining := 0
	for _, contents := range lib.files {
		if bridgeInit.Match(contents) {
			defining++
		}
	}
	if defining != 1 {
		t.Fatalf("the bridge's init is in %d files, want 1", defining)
	}
}

func TestTransformPrepareAndServe(t *testing.T) {
	root := writeProject(t, map[string]string{
		"index.ts": `import { b } from "./src/b";
import fn from "cjs-fn";
import { a } from "cjs-obj";
import esm, { named } from "esm-only";
import { sub } from "esm-only/sub";
import browser from "browser-pkg";
import { x } from "with-css";
import fs from "fs";
import { join } from "node:path";
import "./style.css";
import data from "./data.json";
import logo from "./logo.png";
console.log(b, fn, a, esm, named, sub, browser, x, fs, join, data, logo);
`,
		"src/b.ts":      `export const b: number = 1;`,
		"style.css":     `body { color: blue; }`,
		"data.json":     `{"k": 1}`,
		"logo.png":      "png",
		"tsconfig.json": `{}`,
	})
	prepareOK(t, root)

	html := serve(t, root, "/")
	if !strings.Contains(html, `src="`+TransformEntryPath+`"`) {
		t.Fatalf("no entry in %s", html)
	}
	if !strings.Contains(html, `href="/@deps/`) || !strings.Contains(html, `.css"`) {
		t.Fatalf("the css of with-css is not linked: %s", html)
	}

	for _, preload := range []string{"/@lib/fullstacked/index.js", "/@lib/fs/index.js", "/@deps/cjs-fn.js", "/index.ts", "/src/b.ts"} {
		if !strings.Contains(html, `<link rel="modulepreload" href="`+preload+`"/>`) {
			t.Errorf("%s is not preloaded", preload)
		}
	}

	entry := serve(t, root, TransformEntryPath)
	if !strings.Contains(entry, `import "/@lib/fullstacked/index.js"`) || !strings.Contains(entry, `await import("/index.ts")`) {
		t.Fatalf("entry: %s", entry)
	}

	index := serve(t, root, "/index.ts")
	for _, want := range []string{
		`from "/src/b.ts"`,
		`from "/@lib/fs/index.js"`,
		`from "/@lib/path/index.js"`,
		`"/@import/style.css"`,
		`from "/@import/data.json"`,
		`from "/@import/logo.png"`,
		`from "/@deps/cjs-fn.js"`,
		`from "/@deps/esm-only.js"`,
		`from "/@deps/esm-only/sub.js"`,
		`from "/@deps/browser-pkg.js"`,
	} {
		if !strings.Contains(index, want) {
			t.Errorf("index.ts has no %s", want)
		}
	}
	if strings.Contains(index, "(): number") || strings.Contains(index, ": number =") {
		t.Errorf("index.ts is not transformed")
	}

	b := serve(t, root, "/src/b.ts")
	if !strings.Contains(b, "var b = 1") && !strings.Contains(b, "const b = 1") {
		t.Errorf("b.ts: %s", b)
	}

	// the browser field, as in a bundle
	browserDep := serve(t, root, "/@deps/browser-pkg.js")
	if !strings.Contains(browserDep, `"browser"`) || strings.Contains(browserDep, `"node"`) {
		t.Errorf("browser-pkg: %s", browserDep)
	}

	// a package's require of a lib module goes to the lib's page path
	cjsObj := serve(t, root, "/@deps/cjs-obj.js")
	allDeps := cjsObj
	state := transformStateFor(root)
	for _, contents := range state.deps.files {
		allDeps += string(contents)
	}
	if !strings.Contains(allDeps, `"/@lib/events/index.js"`) {
		t.Errorf("events is not imported from the lib")
	}

	// the stylesheets a module imports are the page's style.css, linked in
	// its head as a bundle's index.css: the module is only their URL
	if css := serve(t, root, "/@import/style.css"); css != "export default \"/style.css\";\n" {
		t.Errorf("css module: %s", css)
	}
	if !strings.Contains(html, `<link rel="stylesheet" href="`+TransformStylePath+`"/>`) {
		t.Errorf("style.css is not linked: %s", html)
	}
	if style := serve(t, root, TransformStylePath); !strings.Contains(style, "color: blue") {
		t.Errorf("style.css: %s", style)
	}
	if css := serve(t, root, "/@css/style.css"); !strings.Contains(css, "color: blue") {
		t.Errorf("css: %s", css)
	}
	if json := serve(t, root, "/@import/data.json"); !strings.Contains(json, `export default {"k": 1}`) {
		t.Errorf("json module: %s", json)
	}
	if png := serve(t, root, "/@import/logo.png"); !strings.Contains(png, `export default "/logo.png"`) {
		t.Errorf("file module: %s", png)
	}
	if lib := serve(t, root, "/@lib/fs/index.js"); lib == "" {
		t.Errorf("no lib")
	}
}

func TestTransformScanErrors(t *testing.T) {
	root := writeProject(t, map[string]string{
		"index.ts": `import { missing } from "./nope"; console.log(missing);`,
	})
	result := PrepareTransformFn(nil, root)
	if len(result.Errors) == 0 {
		t.Fatal("a missing import is an error")
	}

	root = writeProject(t, map[string]string{
		"index.ts": `const x = ;`,
	})
	result = PrepareTransformFn(nil, root)
	if len(result.Errors) == 0 || result.Errors[0].Location == nil {
		t.Fatalf("a syntax error is an error with its location: %+v", result.Errors)
	}
	if html := serve(t, root, "/"); !strings.Contains(html, "[ERROR]") {
		t.Fatalf("the page shows the errors: %s", html)
	}
}

func TestTransformModuleCache(t *testing.T) {
	root := writeProject(t, map[string]string{
		"index.ts": `import { v } from "./v"; console.log(v);`,
		"v.ts":     `export const v = "first";`,
	})
	prepareOK(t, root)
	if v := serve(t, root, "/v.ts"); !strings.Contains(v, `"first"`) {
		t.Fatalf("v.ts: %s", v)
	}

	// another size and time: transformed again
	time.Sleep(10 * time.Millisecond)
	os.WriteFile(filepath.Join(root, "v.ts"), []byte(`export const v = "second one";`), 0644)
	if v := serve(t, root, "/v.ts"); !strings.Contains(v, `"second one"`) {
		t.Fatalf("v.ts after an edit: %s", v)
	}

	// an edit that breaks it: a module that shows the error
	os.WriteFile(filepath.Join(root, "v.ts"), []byte(`export const v = ;`), 0644)
	if v := serve(t, root, "/v.ts"); !strings.Contains(v, "fullstacked-error-overlay") {
		t.Fatalf("v.ts with an error: %s", v)
	}

	// an edit that imports a package the scan did not see: the
	// dependencies are built again with it
	os.WriteFile(filepath.Join(root, "v.ts"), []byte(`import fn from "cjs-fn"; export const v = fn;`), 0644)
	if v := serve(t, root, "/v.ts"); !strings.Contains(v, `from "/@deps/cjs-fn.js"`) {
		t.Fatalf("v.ts with a new package: %s", v)
	}
	if dep := serve(t, root, "/@deps/cjs-fn.js"); !strings.Contains(dep, "cjsFn") {
		t.Fatalf("cjs-fn: %s", dep)
	}
}

func TestTransformDepsCache(t *testing.T) {
	root := writeProject(t, map[string]string{
		"index.ts": `import fn from "cjs-fn"; console.log(fn);`,
	})
	deps, errs := ensureDeps(root, []string{"cjs-fn"}, nil, nil)
	if len(errs) > 0 {
		t.Fatal(errs)
	}
	if _, err := os.Stat(filepath.Join(depsCacheDir(root), "manifest.json")); err != nil {
		t.Fatal("no cache written")
	}

	// a new state (the next run) reads the cache: same files
	cached := readDepsCache(root, deps.key)
	if cached == nil || len(cached.files) != len(deps.files) || cached.urls["cjs-fn"] != deps.urls["cjs-fn"] {
		t.Fatal("the cache is not read back")
	}

	// a lockfile change is another key
	os.WriteFile(filepath.Join(root, "package-lock.json"), []byte(`{"lockfileVersion":3}`), 0644)
	if depsKey(root, []string{"cjs-fn"}, nil) == deps.key {
		t.Fatal("the lockfile is not part of the key")
	}
}

func TestTransformContainment(t *testing.T) {
	root := writeProject(t, map[string]string{
		"index.ts": `console.log(1);`,
	})
	outside := filepath.Join(filepath.Dir(root), "outside.ts")
	os.WriteFile(outside, []byte(`export const secret = 1;`), 0644)
	defer os.Remove(outside)

	prepareOK(t, root)
	for _, pathname := range []string{"/../outside.ts", "/%2e%2e/outside.ts", "/@import/../outside.ts", "/@import/%2e%2e/outside.ts"} {
		_, contents, handled := ServeTransform(transformCtx(root), pathname)
		if handled && contents != nil {
			t.Errorf("%s is served", pathname)
		}
	}

	root = writeProject(t, map[string]string{
		"index.ts": `import "../outside";`,
	})
	if result := PrepareTransformFn(nil, root); len(result.Errors) == 0 {
		t.Error("an import outside of the project is an error")
	}
}

func TestDepOutputName(t *testing.T) {
	taken := map[string]bool{}
	for spec, want := range map[string]string{
		"react":                 "react",
		"react-dom/client":      "react-dom/client",
		"@scope/pkg/sub":        "@scope/pkg/sub",
		"./node_modules/x/y.js": "node_modules/x/y.js",
		"a/../b":                "a/-../b",
		"_private":              "-_private",
	} {
		if got := depOutputName(spec, taken); got != want {
			t.Errorf("%s: %s, want %s", spec, got, want)
		}
	}
	if got := depOutputName("react", taken); got != "react-2" {
		t.Errorf("a taken name gets a suffix: %s", got)
	}
}

func TestParseDepUsage(t *testing.T) {
	output := []byte(`import React, { useState as useState2, useEffect } from "react";
import * as R from "react-dom";
import * as THREE from "three-ns";
import * as Passed from "passed";
// a comment naming THREE is not a use
/* nor is
   THREE in a block */
const mesh = new THREE.Mesh(THREE.BoxGeometry);
console.log(Passed);
import "side-effect";
import {
  Mesh,
  Scene
} from "three";
export { a } from "reexported";
export * from "star";
const lazy = import("lazy");
const old = __require("required");
`)
	specs := []string{"react", "react-dom", "side-effect", "three", "three-ns", "passed", "reexported", "star", "lazy", "required", "unseen"}
	usage := parseDepUsage(output, specs)
	want := map[string][]string{
		"react":       {"default", "useEffect", "useState"},
		"react-dom":   {},
		"three-ns":    {"BoxGeometry", "Mesh"},
		"passed":      {"*"},
		"side-effect": {},
		"three":       {"Mesh", "Scene"},
		"reexported":  {"a"},
		"star":        {"*"},
		"lazy":        {"*"},
		"required":    {"*"},
		"unseen":      {"*"},
	}
	for spec, names := range want {
		got := usage[spec]
		if strings.Join(got, ",") != strings.Join(names, ",") {
			t.Errorf("%s: %v, want %v", spec, got, names)
		}
	}
}

func TestTransformInBackground(t *testing.T) {
	PretransformBeforePage = false
	defer func() { PretransformBeforePage = true }()

	files := map[string]string{"index.ts": ""}
	for i := 0; i < 40; i++ {
		name := "m" + itoa(i) + ".ts"
		files[name] = "export const v: number = " + itoa(i) + ";"
		files["index.ts"] += "import { v as v" + itoa(i) + " } from \"./" + name + "\";\nconsole.log(v" + itoa(i) + ");\n"
	}
	root := writeProject(t, files)
	prepareOK(t, root)

	// the page asks while prepare's goroutines transform: each module once,
	// whoever starts it, and every request gets it
	done := make(chan string, 40)
	for i := 0; i < 40; i++ {
		go func(i int) {
			_, contents, _ := ServeTransform(transformCtx(root), "/m"+itoa(i)+".ts")
			done <- string(contents)
		}(i)
	}
	for i := 0; i < 40; i++ {
		if contents := <-done; !strings.Contains(contents, "var v = ") {
			t.Fatalf("module: %s", contents)
		}
	}
	if html := serve(t, root, "/"); !strings.Contains(html, `href="/m39.ts"`) {
		t.Fatal("the modules are preloaded")
	}
}
