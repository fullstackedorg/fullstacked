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
	pathname, err := url.PathUnescape(pathname)
	if err != nil {
		return "", nil, false
	}

	// a page path uses / only, a \ is a separator on Windows
	pathname = strings.ReplaceAll(pathname, "\\", "/")
	pathname = strings.Trim(pathname, "/")

	// C:/... is still absolute once trimmed on Windows
	if filepath.VolumeName(pathname) != "" {
		return "", nil, false
	}

	for _, dir := range []string{ctx.Directories.Build, ctx.Directories.Root} {
		file, inside := joinInside(dir, pathname)
		if !inside {
			continue
		}

		foundPath, contents, err := resolveFile(file)
		if err != nil {
			continue
		}

		mimeType := mime.TypeByExtension(filepath.Ext(foundPath))

		if mimeType == "" {
			mimeType = "text/plain"
		}

		return mimeType, contents, true
	}

	return "", nil, false
}

// pathname joined to dir, false when it resolves outside of dir (../ in any
// form). Same containment as path.ResolveWithContext, but a page path outside
// of dir is not found instead of clamped to dir.
func joinInside(dir string, pathname string) (string, bool) {
	joined := filepath.Clean(filepath.Join(dir, pathname))

	rel, err := filepath.Rel(dir, joined)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", false
	}

	return joined, true
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
