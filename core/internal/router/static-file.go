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
func staticFile(ctx *types.Context, pathname string) []byte {
	pathname, _ = url.PathUnescape(pathname)
	pathname = strings.TrimLeft(pathname, "/")
	pathname = strings.TrimRight(pathname, "/")

	pathname = path.Join(ctx.Directories.Root, pathname)
	pathname, contents, err := resolveFile(ctx, pathname)

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

func resolveFile(ctx *types.Context, pathname string) (string, []byte, error) {
	pathname = resolveBundledHtmlFile(ctx, pathname)
	pathname = resolveBundledCssFile(ctx, pathname)
	pathname = resolveBundledJsFile(ctx, pathname)

	exists := fs.ExistsFn(pathname)
	if !exists {
		if strings.HasSuffix(pathname, "index.html") {
			html, err := generateIndexHTML(ctx, path.Dir(pathname))

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
		return resolveFile(ctx, path.Join(pathname, "index.html"))
	}

	return resolvedFileContents(pathname)
}

func resolveBundledJsFile(ctx *types.Context, pathname string) string {
	ext := path.Ext(pathname)

	if !slices.Contains(bundle.BundleExtensions, ext) {
		return pathname
	}

	name := path.Base(pathname)
	midDirectories := strings.TrimPrefix(pathname, ctx.Directories.Root)
	midDirectories = strings.TrimSuffix(midDirectories, name)

	bundleJsPathname := path.Join(
		ctx.Directories.Build,
		midDirectories,
		"_"+name+".js")
	if fs.ExistsFn(bundleJsPathname) {
		return bundleJsPathname
	}

	return pathname
}

func resolveBundledCssFile(ctx *types.Context, pathname string) string {
	ext := path.Ext(pathname)

	if ext != ".css" {
		return pathname
	}

	name := path.Base(pathname)
	midDirectories := strings.TrimPrefix(pathname, ctx.Directories.Root)
	midDirectories = strings.TrimSuffix(midDirectories, name)

	bundleCssPathname := path.Join(
		ctx.Directories.Build,
		midDirectories,
		"_"+name,
	)
	if fs.ExistsFn(bundleCssPathname) {
		return bundleCssPathname
	}

	return pathname
}

func resolveBundledHtmlFile(ctx *types.Context, pathname string) string {
	ext := path.Ext(pathname)

	if ext != ".html" {
		return pathname
	}

	name := path.Base(pathname)
	midDirectories := strings.TrimPrefix(pathname, ctx.Directories.Root)
	midDirectories = strings.TrimSuffix(midDirectories, name)

	bundleHtmlPathname := path.Join(
		ctx.Directories.Build,
		midDirectories,
		name,
	)
	if fs.ExistsFn(bundleHtmlPathname) {
		return bundleHtmlPathname
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
