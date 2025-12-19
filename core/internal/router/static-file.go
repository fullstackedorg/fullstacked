package router

import (
	"errors"
	"fullstackedorg/fullstacked/internal/bundle"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/types"
	"mime"
	"net/url"
	"path"
	"slices"
	"strings"
)

// ONLY function in core returning a serialized response
// because adapters needs to read both mime type string and file content buffer
// buffer of size 0 means not found
func staticFile(ctx *types.CoreCallContext, pathname string) []byte {
	pathname, _ = url.PathUnescape(pathname)
	pathname = strings.TrimLeft(pathname, "/")
	pathname = strings.TrimRight(pathname, "/")

	pathname = path.Join(ctx.BaseDirectory, pathname)

	pathname, err := resolveFile(pathname)

	if err != nil {
		return []byte{}
	}

	contents, err := fs.ReadFileFn(pathname)

	if err != nil {
		return []byte{}
	}

	ext := path.Ext(pathname)

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

func resolveFile(pathname string) (string, error) {
	exists := fs.ExistsFn(pathname)
	if !exists {
		return "", errors.New("not existing")
	}

	stats, err := fs.StatsFn(pathname)

	if err != nil {
		return "", errors.New("failed to stats")
	}

	if stats.IsDir {
		return resolveFile(path.Join(pathname, "index.html"))
	}

	return resolveBundledFile(pathname), nil
}

func resolveBundledFile(pathname string) string {
	ext := path.Ext(pathname)

	if !slices.Contains(bundle.BundleExtensions, ext) {
		return pathname
	}

	bundlePathname := path.Join(path.Dir(pathname), "_"+path.Base(pathname)+".js")

	if fs.ExistsFn(bundlePathname) {
		return bundlePathname
	}

	return pathname
}
