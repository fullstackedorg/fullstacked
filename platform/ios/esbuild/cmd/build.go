package main

import "C"

import (
	"encoding/json"

	"github.com/evanw/esbuild/pkg/api"
)

//export buildWebview
func buildWebview(entryPoint *C.char, OutDir *C.char, errors **C.char) {
	result := api.Build(api.BuildOptions{
		EntryPoints: []string{C.GoString(entryPoint)},
		Outfile:     C.GoString(OutDir) + "/index.js",
		Sourcemap:   api.SourceMapInlineAndExternal,
		Bundle:      true,
		Format:      api.FormatESModule,
		Write:       true,
	})

	if len(result.Errors) > 0 {
		errorsJSON, _ := json.Marshal(result.Errors)
		*errors = C.CString(string(errorsJSON))
	}
}

//export buildAPI
func buildAPI(entryPoint *C.char, errors **C.char) *C.char {
	result := api.Build(api.BuildOptions{
		EntryPoints: []string{C.GoString(entryPoint)},
		Bundle:      true,
		GlobalName:  "api",
		Format:      api.FormatIIFE,
		Write:       false,
	})

	if len(result.Errors) > 0 {
		errorsJSON, _ := json.Marshal(result.Errors)
		*errors = C.CString(string(errorsJSON))
		return nil
	}

	return C.CString(string(result.OutputFiles[0].Contents[:]))
}
