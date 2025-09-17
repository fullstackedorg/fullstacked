package ts_lsp

import (
	"fmt"
	"fullstackedorg/fullstacked/src/fs"
	"strings"
	"time"

	tsgo "github.com/microsoft/typescript-go/cmd/module"
)

type WasmFS struct{}

// Chtimes implements vfs.FS.
func (w *WasmFS) Chtimes(path string, aTime time.Time, mTime time.Time) error {
	fmt.Println("Chtimes")
	panic("unimplemented")
}

// DirectoryExists implements vfs.FS.
func (w *WasmFS) DirectoryExists(path string) bool {
	exist, isFile := fs.Exists(path)
	return exist && !isFile
}

// FileExists implements vfs.FS.
func (w *WasmFS) FileExists(path string) bool {
	exist, isFile := fs.Exists(path)
	return exist && isFile
}

// GetAccessibleEntries implements vfs.FS.
func (w *WasmFS) GetAccessibleEntries(path string) tsgo.FsEntries {
	items, _ := fs.ReadDir(path, true, false, []string{})
	entries := tsgo.FsEntries{
		Files:       []string{},
		Directories: []string{},
	}
	for _, item := range items {
		name := strings.TrimSpace(item.Name)
		if strings.HasSuffix(name, "/") || name == "" {
			continue
		}

		if item.IsDir {
			entries.Directories = append(entries.Directories, name)
		} else {
			entries.Files = append(entries.Files, name)
		}
	}
	return entries
}

// ReadFile implements vfs.FS.
func (w *WasmFS) ReadFile(path string) (contents string, ok bool) {
	data, err := fs.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(data), true
}

// Realpath implements vfs.FS.
func (w *WasmFS) Realpath(path string) string {
	return path
}

// Remove implements vfs.FS.
func (w *WasmFS) Remove(path string) error {
	exist, isFile := fs.Exists(path)
	if !exist {
		return nil
	}

	if isFile {
		fs.Unlink(path, "tsgo")
	} else {
		fs.Rmdir(path, "tsgo")
	}

	return nil
}

// Stat implements vfs.FS.
func (w *WasmFS) Stat(path string) tsgo.FsFileInfo {
	fmt.Println("Stat")
	return nil
}

// UseCaseSensitiveFileNames implements vfs.FS.
func (w *WasmFS) UseCaseSensitiveFileNames() bool {
	return true
}

// WalkDir implements vfs.FS.
func (w *WasmFS) WalkDir(root string, walkFn tsgo.FsWalkDirFunc) error {
	fmt.Println("WalkDir")
	panic("unimplemented")
}

// WriteFile implements vfs.FS.
func (w *WasmFS) WriteFile(path string, data string, writeByteOrderMark bool) error {
	return fs.WriteFile(path, []byte(data), "tsgo")
}
