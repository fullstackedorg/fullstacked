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

	pathname, contents, err := resolveFile(pathname)

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

func resolveFile(pathname string) (string, []byte, error) {
	exists := fs.ExistsFn(pathname)
	if !exists {
		if strings.HasSuffix(pathname, "index.html") {
			html, err := generateIndexHTML(path.Dir(pathname))

			if err != nil {
				return "", nil, err
			}

			return pathname, html, nil
		} else {
			return "", nil, errors.New("not found")
		}
	}

	stats, err := fs.StatsFn(pathname)

	if err != nil {
		return "", nil, err
	}

	if stats.IsDir {
		return resolveFile(path.Join(pathname, "index.html"))
	}

	pathname = resolveBundledFile(pathname)

	return resolvedFileContents(pathname)
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

func resolvedFileContents(pathname string) (string, []byte, error) {
	contents, err := fs.ReadFileFn(pathname)

	if err != nil {
		return "", nil, err
	}

	return pathname, contents, nil
}
