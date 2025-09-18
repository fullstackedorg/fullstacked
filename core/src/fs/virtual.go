package fs

import (
	"errors"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

type vFile struct {
	Data    []byte
	ModTime time.Time
}

var VirtFS = make(map[string]*vFile)
var VirtDirs = []string{}

func vReadFile(path string) ([]byte, error) {
	f := VirtFS[path]

	if f == nil {
		return nil, errors.New("ENOENT")
	}

	return f.Data, nil
}

func vWriteFile(path string, data []byte) error {
	if VirtFS[path] == nil {
		VirtFS[path] = &vFile{
			Data:    []byte{},
			ModTime: time.Now(),
		}
	}

	VirtFS[path].Data = data
	return nil
}

func vUnlink(path string) error {
	delete(VirtFS, path)
	return nil
}

func vMkdir(path string) error {
	path = strings.TrimSpace(path)
	path = strings.TrimRight(path, "/")

	pathComponents := strings.Split(path, "/")
	for i := range pathComponents {
		subdir := strings.Join(pathComponents[:i+1], "/")
		exists := false
		for _, dir := range VirtDirs {
			if subdir == dir {
				exists = true
			}
		}

		if !exists {
			VirtDirs = append(VirtDirs, subdir)
		}
	}

	return nil
}

func vRmdir(path string) error {
	indexesToRemove := []int{}

	for i, dir := range VirtDirs {
		if dir == path || pathIsChildOfPath(dir, path) {
			indexesToRemove = append(indexesToRemove, i)
		}
	}

	for i := len(indexesToRemove) - 1; i >= 0; i-- {
		indexToRemove := indexesToRemove[i]
		VirtDirs[indexToRemove] = VirtDirs[len(VirtDirs)-1]
		VirtDirs = VirtDirs[:len(VirtDirs)-1]
	}

	for file := range VirtFS {
		if pathIsChildOfPath(file, path) {
			delete(VirtFS, file)
		}
	}

	return nil
}

func vExists(path string) (bool, bool) {
	for _, dir := range VirtDirs {
		if path == dir {
			return true, false
		}
	}

	for file := range VirtFS {
		if file == path {
			return true, true
		}
	}

	return false, false
}

func vStat(path string) *FileInfo2 {
	f := VirtFS[path]
	d := false

	for _, dir := range VirtDirs {
		if dir == path {
			d = true
			break
		}
	}

	if f == nil || d {
		return nil
	}

	pathComponents := strings.Split(path, "/")

	mode := os.ModeDir
	if !d {
		mode = 0666
	}

	return &FileInfo2{
		Name:  pathComponents[len(pathComponents)-1],
		Size:  int64(len(f.Data)),
		ATime: f.ModTime,
		MTime: f.ModTime,
		CTime: f.ModTime,
		IsDir: d,
		Mode:  mode,
	}
}

func vRename(oldPath string, newPath string) error {
	for i, dir := range VirtDirs {
		if strings.HasPrefix(dir, oldPath) {
			VirtDirs[i] = strings.Replace(dir, oldPath, newPath, 1)
		}
	}

	for file, data := range VirtFS {
		if strings.HasPrefix(file, oldPath) {
			newFile := strings.Replace(file, oldPath, newPath, 1)
			VirtFS[newFile] = data
			delete(VirtFS, file)
		}
	}

	return nil
}

func splitPath(filePath string) []string {
	pathComponents := []string{}
	remaining := filePath

	for remaining != "" {
		dir, file := path.Split(remaining)
		pathComponents = append(pathComponents, file)

		if dir == "" {
			break
		}

		remaining = dir[:len(dir)-1]
	}

	reversed := make([]string, len(pathComponents))

	for i := range reversed {
		reversed[i] = pathComponents[len(pathComponents)-1-i]
	}

	return reversed
}

func pathIsChildOfPath(childPath string, parentPath string) bool {
	childPathComponents := strings.Split(childPath, "/")
	parentPathComponents := strings.Split(parentPath, "/")

	if len(childPathComponents) < len(parentPathComponents) {
		return false
	}

	for i, parentPathComponent := range parentPathComponents {
		if parentPathComponent != childPathComponents[i] {
			return false
		}
	}

	return true
}

//	projects/node_modules/react/index.js
//	projects/node_modules/react-dom/index.js
//
// path: projects/node_modules/react
func vReadDir(path string, recursive bool, filesOnly bool, skip []string) []FileInfo2 {
	items := []FileInfo2{}

	pathComponents := splitPath(path)

	if !filesOnly {
		for _, dir := range VirtDirs {
			if pathIsChildOfPath(dir, path) {
				dirComponents := splitPath(dir)
				relativeName := filepath.Join(dirComponents[len(pathComponents):]...)
				if containsStartsWith(skip, relativeName) {
					continue
				}
				if recursive || len(dirComponents)-len(pathComponents) == 1 {
					items = append(items, FileInfo2{
						Name:  relativeName,
						IsDir: true,
						Mode:  os.ModeDir,
					})
				}
			}
		}
	}

	for file := range VirtFS {
		if pathIsChildOfPath(file, path) {
			fileComponents := splitPath(file)
			relativeName := filepath.Join(fileComponents[len(pathComponents):]...)
			if containsStartsWith(skip, relativeName) {
				continue
			}
			if recursive || len(fileComponents)-len(pathComponents) == 1 {
				items = append(items, FileInfo2{
					Name:  relativeName,
					IsDir: false,
					Mode:  0666,
				})
			}
		}
	}

	return items
}
