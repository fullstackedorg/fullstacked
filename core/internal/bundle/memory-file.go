package bundle

import (
	"crypto/rand"
	"encoding/hex"
	fspath "fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/types"
	"path/filepath"
	"strings"
	"sync"
	"time"

	esbuild "github.com/evanw/esbuild/pkg/api"
)

// A script run with fullstacked --file is bundled in memory and served once
// at a path of its own next to the file (<file>.fullstacked-<id>.js): its
// import.meta.url points next to the script as before, two runs of one
// script don't share a file, a read-only folder runs scripts, and a crash
// leaves nothing behind.
var (
	memoryFilesMu sync.Mutex
	memoryFiles   = map[string][]byte{}
)

// how long a bundle waits to be imported
var memoryFileLifetime = 5 * time.Minute

const memoryFileMarker = ".fullstacked-"

func BundleFileInMemoryFn(ctx *types.Context, entryPoint string) EsbuildResult {
	buildOptions, err := prepareBundleOptions(entryPoint)
	if err != nil {
		return errorResult(err)
	}

	id := make([]byte, 8)
	rand.Read(id)
	buildOptions.Outfile = buildOptions.Stdin.Sourcefile + memoryFileMarker + hex.EncodeToString(id) + ".js"

	result := esbuild.Build(buildOptions)

	esbuildResult := EsbuildResult{
		Errors:      result.Errors,
		Warnings:    result.Warnings,
		OutputFiles: []string{},
	}

	if len(result.Errors) == 0 {
		for _, file := range result.OutputFiles {
			if !strings.HasSuffix(file.Path, ".js") {
				continue
			}
			key := filepath.Clean(file.Path)
			memoryFilesMu.Lock()
			memoryFiles[key] = file.Contents
			memoryFilesMu.Unlock()
			time.AfterFunc(memoryFileLifetime, func() { TakeMemoryFile(key) })
			esbuildResult.OutputFiles = append(esbuildResult.OutputFiles, fspath.RelativeToCwd(ctx, file.Path))
		}
	}

	return esbuildResult
}

// TakeMemoryFile is the bundle in memory at file, once: false when there is
// none (any other file is on disk)
func TakeMemoryFile(file string) ([]byte, bool) {
	if !strings.Contains(filepath.Base(file), memoryFileMarker) {
		return nil, false
	}
	key := filepath.Clean(file)
	memoryFilesMu.Lock()
	defer memoryFilesMu.Unlock()
	contents, ok := memoryFiles[key]
	if ok {
		delete(memoryFiles, key)
	}
	return contents, ok
}
