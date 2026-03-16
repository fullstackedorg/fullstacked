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
	pathname, _ = url.PathUnescape(pathname)
	pathname = strings.TrimLeft(pathname, "/")
	pathname = strings.TrimRight(pathname, "/")

	foundPath, contents, err := resolveFile(filepath.Join(ctx.Directories.Build, pathname))
	if err != nil {
		foundPath, contents, err = resolveFile(filepath.Join(ctx.Directories.Root, pathname))
	}
	pathname = foundPath

	if err != nil {
		return []byte{}
	}

	ext := filepath.Ext(pathname)

	mimeType := mime.TypeByExtension(ext)

	if mimeType == "" {
		mimeType = "text/plain"
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
