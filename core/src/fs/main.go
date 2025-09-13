package fs

import (
	"errors"
	serialize "fullstackedorg/fullstacked/src/serialize"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/djherbis/times"
)

var WASM = false

func ReadFile(path string) ([]byte, error) {
	fileData := ([]byte)(nil)
	err := (error)(nil)

	exists, isFile := Exists(path)

	if !exists {
		return nil, errors.New("ENOENT")
	}

	if !isFile {
		return nil, errors.New("EISDIR")
	}

	if WASM {
		fileData, err = vReadFile(path)
	} else {
		fileData, err = os.ReadFile(path)
	}

	if err != nil {
		return nil, err
	}

	return fileData, nil
}

func ReadFileSerialized(path string, asString bool) []byte {
	fileData, err := ReadFile(path)

	if err != nil {
		return serialize.SerializeError(err)
	}

	if asString {
		return serialize.SerializeString(string(fileData))
	}

	return serialize.SerializeBuffer(fileData)
}

func WriteFile(path string, data []byte, origin string) error {
	err := (error)(nil)

	exists, _ := Exists(path)

	if WASM {
		err = vWriteFile(path, data)
	} else {
		err = os.WriteFile(path, data, 0644)
	}

	if !exists {
		watchEvent(FileEvent{
			Type:   CREATED,
			Paths:  []string{path},
			Origin: origin,
			IsFile: true,
		})
	} else {
		watchEvent(FileEvent{
			Type:   MODIFIED,
			Paths:  []string{path},
			Origin: origin,
			IsFile: true,
		})
	}

	return err
}

func WriteFileSerialized(path string, data []byte, origin string) []byte {
	err := WriteFile(path, data, origin)
	if err == nil {
		return []byte{}
	}
	return serialize.SerializeString(err.Error())
}

func Unlink(path string, origin string) error {
	err := (error)(nil)

	if WASM {
		err = vUnlink(path)
	} else {
		err = os.Remove(path)
	}

	watchEvent(FileEvent{
		Type:   DELETED,
		Paths:  []string{path},
		Origin: origin,
		IsFile: true,
	})

	return err
}

func UnlinkSerialized(path string, origin string) []byte {
	err := Unlink(path, origin)
	if err == nil {
		return []byte{}
	}
	return serialize.SerializeString(err.Error())
}

func containsStartsWith(arr []string, e string) bool {
	for _, i := range arr {
		if strings.HasPrefix(e, i) {
			return true
		}
	}

	return false
}

func ReadDir(path string, recursive bool, filesOnly bool, skip []string) ([]FileInfo2, error) {
	items := []FileInfo2{}

	exists, isFile := Exists(path)
	if !exists {
		return nil, errors.New("ENOENT")
	}

	if isFile {
		return nil, errors.New("ENOTDIR")
	}

	if WASM {
		items = vReadDir(path, recursive, filesOnly, skip)
	} else {
		pathComponents := splitPath(filepath.ToSlash(path))

		if recursive {
			err := filepath.WalkDir(path, func(path string, d fs.DirEntry, err error) error {
				if err != nil {
					return err
				}

				if filesOnly && d.IsDir() {
					return nil
				}

				itemPathComponents := splitPath(filepath.ToSlash(path))

				relativeName := strings.Join(itemPathComponents[len(pathComponents):], "/")

				if containsStartsWith(skip, relativeName) {
					return nil
				}

				info, _ := d.Info()

				items = append(items, FileInfo2{
					Name:  relativeName,
					IsDir: d.IsDir(),
					Mode:  info.Mode(),
				})

				return nil
			})

			if err != nil {
				return nil, err
			}
		} else {

			entries, err := os.ReadDir(path)

			if err != nil {
				return nil, err
			}

			for _, item := range entries {
				info, _ := item.Info()

				if filesOnly && item.IsDir() {
					continue
				}

				items = append(items, FileInfo2{
					Name:  item.Name(),
					IsDir: item.IsDir(),
					Mode:  info.Mode(),
				})
			}
		}
	}

	return items, nil
}

func ReadDirSerialized(path string, recursive bool, withFileTypes bool, filesOnly bool, skip []string) []byte {
	items := ([]FileInfo2)(nil)
	err := (error)(nil)

	if WASM {
		items = vReadDir(path, recursive, filesOnly, skip)
	} else {
		items, err = ReadDir(path, recursive, filesOnly, skip)

		if err != nil {
			return serialize.SerializeError(err)
		}
	}

	bytes := []byte{}
	for _, item := range items {

		bytes = append(bytes, serialize.SerializeString(item.Name)...)

		if withFileTypes {
			bytes = append(bytes, serialize.SerializeBoolean(item.IsDir)...)
		}
	}

	return bytes
}

func Mkdir(path string, origin string) bool {
	err := (error)(nil)

	exists, _ := Exists(path)

	if WASM {
		err = vMkdir(path)
	} else {
		err = os.MkdirAll(path, 0755)
	}

	if !exists {
		watchEvent(FileEvent{
			Type:   CREATED,
			Paths:  []string{path},
			Origin: origin,
			IsFile: false,
		})
	}

	return err == nil
}

func MkdirSerialized(path string, origin string) []byte {
	return serialize.SerializeBoolean(Mkdir(path, origin))
}

func Rmdir(path string, origin string) bool {
	exists, _ := Exists(path)

	if !exists {
		return true
	}

	err := (error)(nil)

	if WASM {
		err = vRmdir(path)
	} else {
		err = os.RemoveAll(path)
	}

	watchEvent(FileEvent{
		Type:   DELETED,
		Paths:  []string{path},
		Origin: origin,
		IsFile: false,
	})

	return err == nil
}

func RmdirSerialized(path string, origin string) []byte {
	return serialize.SerializeBoolean(Rmdir(path, origin))
}

func Exists(path string) (bool, bool) {
	exists := false
	isFile := false

	if WASM {
		exists, isFile = vExists(path)
	} else {
		stat, err := os.Stat(path)
		if err == nil {
			exists = true
			isFile = !stat.IsDir()
		}
	}

	return exists, isFile
}

func ExistsSerialized(path string) []byte {
	bytes := []byte{}
	exists, isFile := Exists(path)
	bytes = append(bytes, serialize.SerializeBoolean(exists)...)
	bytes = append(bytes, serialize.SerializeBoolean(isFile)...)
	return bytes
}

type FileInfo2 struct {
	Name  string
	Size  int64
	ATime time.Time
	MTime time.Time
	CTime time.Time
	IsDir bool
	Mode  os.FileMode
}

func Stat(path string) (*FileInfo2, error) {
	exists, _ := Exists(path)

	if !exists {
		return nil, errors.New("ENOENT")
	}

	if WASM {
		return vStat(path), nil
	}

	fileInfo, err := os.Stat(path)

	if err != nil {
		return nil, err
	}

	t, _ := times.Stat(path)

	mTime := t.ModTime()
	aTime := t.AccessTime()

	cTime := mTime
	if t.HasChangeTime() {
		cTime = t.ChangeTime()
	}

	return &FileInfo2{
		Name:  fileInfo.Name(),
		Size:  fileInfo.Size(),
		ATime: aTime,
		MTime: mTime,
		CTime: cTime,
		IsDir: fileInfo.IsDir(),
		Mode:  fileInfo.Mode(),
	}, nil
}

func StatSerialized(path string) []byte {
	stats, err := Stat(path)

	if err != nil {
		return serialize.SerializeError(err)
	}

	bytes := []byte{}

	bytes = append(bytes, serialize.SerializeString(stats.Name)...)
	bytes = append(bytes, serialize.SerializeNumber(float64(stats.Size))...)
	bytes = append(bytes, serialize.SerializeNumber(float64(stats.ATime.UnixMilli()))...)
	bytes = append(bytes, serialize.SerializeNumber(float64(stats.MTime.UnixMilli()))...)
	bytes = append(bytes, serialize.SerializeNumber(float64(stats.CTime.UnixMilli()))...)
	bytes = append(bytes, serialize.SerializeBoolean(stats.IsDir)...)

	return bytes
}

func Rename(oldPath string, newPath string, origin string) bool {
	err := (error)(nil)

	_, isFile := Exists(oldPath)

	if WASM {
		err = vRename(oldPath, newPath)
	} else {
		err = os.Rename(oldPath, newPath)
	}

	watchEvent(FileEvent{
		Type:   RENAME,
		Paths:  []string{oldPath, newPath},
		Origin: origin,
		IsFile: isFile,
	})

	return err == nil
}

func RenameSerialized(oldPath string, newPath string, origin string) []byte {
	return serialize.SerializeBoolean(Rename(oldPath, newPath, origin))
}

func Copy(src string, dst string, origin string) error {
	srcExists, srcIsFile := Exists(src)
	if !srcExists {
		return errors.New("ENOENT")
	}

	dstExists, dstIsFile := Exists(dst)

	if dstExists {
		if srcIsFile && !dstIsFile {
			return errors.New("destination is directory")
		} else if !srcIsFile && dstIsFile {
			return errors.New("destination is file")
		}
	}

	if srcIsFile {
		data, err := ReadFile(src)
		if err != nil {
			return err
		}
		WriteFile(dst, data, origin)
	} else {
		items, err := ReadDir(src, true, false, []string{})
		if err != nil {
			return err
		}
		directories := []string{}
		files := []string{}
		for _, item := range items {
			if item.IsDir {
				directories = append(directories, item.Name)
			} else {
				files = append(files, item.Name)
			}
		}

		Rmdir(dst, origin)
		Mkdir(dst, origin)

		for _, dir := range directories {
			Mkdir(path.Join(dst, dir), origin)
		}

		for _, file := range files {
			data, err := ReadFile(path.Join(src, file))
			if err != nil {
				continue
			}
			WriteFile(path.Join(dst, file), data, origin)
		}
	}

	return nil
}
