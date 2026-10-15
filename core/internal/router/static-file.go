package router

import (
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/types"
	"mime"
	"net/url"
	"path/filepath"
	"strings"
)

// this is the ONLY function in the core that returns a serialized value
// adapters needs to receive both mime type and file content
// buffer of size 0 means not found
func staticFile(ctx *types.Context, pathname string) []byte {
	mimeType, contents, ok := resolveStaticFile(ctx, pathname)
	if !ok {
		return []byte{}
	}

	mimeTypeSerialized, err := serialization.Serialize(mimeType)

	if err != nil {
		return []byte{}
	}

	contentsSerialized, err := serialization.Serialize(contents)

	if err != nil {
		return []byte{}
	}

	merged, err := serialization.MergeBuffers(mimeTypeSerialized, contentsSerialized)

	if err != nil {
		return []byte{}
	}

	return merged
}

// the file of a page path in the build directory, then the root directory
func resolveStaticFile(ctx *types.Context, pathname string) (string, []byte, bool) {
	pathname, _ = url.PathUnescape(pathname)
	pathname = strings.TrimLeft(pathname, "/")
	pathname = strings.TrimRight(pathname, "/")

	foundPath, contents, err := resolveFile(filepath.Join(ctx.Directories.Build, pathname))
	if err != nil {
		foundPath, contents, err = resolveFile(filepath.Join(ctx.Directories.Root, pathname))
	}

	if err != nil {
		return "", nil, false
	}

	mimeType := mime.TypeByExtension(filepath.Ext(foundPath))

	if mimeType == "" {
		mimeType = "text/plain"
	}

	return mimeType, contents, true
}

func resolveFile(pathname string) (string, []byte, error) {
	stats, err := fs.StatsFn(pathname)

	if err != nil {
		return "", nil, err
	}

	if stats.IsDir {
		return resolveFile(filepath.Join(pathname, "index.html"))
	}

	return resolvedFileContents(pathname)
}

func resolvedFileContents(pathname string) (string, []byte, error) {
	contents, err := fs.ReadFileFn(pathname)

	if err != nil {
		return "", nil, err
	}

	return pathname, contents, nil
}
