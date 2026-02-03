package fs

import (
	"errors"
	"fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/types"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/djherbis/times"
)

type FsFn = uint8

const (
	Exists   FsFn = 0
	Stats    FsFn = 1
	ReadFile FsFn = 2
	ReadDir  FsFn = 3
)

func Switch(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Exists:
		response.Type = types.CoreResponseData
		response.Data = ExistsFn(path.ResolveWithContext(ctx, data[0].Data.(string)))
		return nil
	case Stats:
		stats, err := StatsFn(path.ResolveWithContext(ctx, data[0].Data.(string)))
		if err != nil {
			return err
		}
		response.Type = types.CoreResponseData
		response.Data = stats
		return nil
	case ReadFile:
		contents, err := ReadFileFn(path.ResolveWithContext(ctx, data[0].Data.(string)))
		if err != nil {
			return err
		}
		response.Type = types.CoreResponseData
		response.Data = contents
		return nil
	case ReadDir:
		recursive := data[1].Data.(bool)
		items := (any)(nil)
		err := (error)(nil)
		if recursive {
			items, err = ReadDirFnRecursive(path.ResolveWithContext(ctx, data[0].Data.(string)))
		} else {
			items, err = ReadDirFn(path.ResolveWithContext(ctx, data[0].Data.(string)))
		}
		if err != nil {
			return err
		}
		response.Data = items
		response.Type = types.CoreResponseData
		return nil
	}

	return errors.New("unkown fs function")
}

func ExistsFn(p string) bool {
	_, err := os.Stat(p)
	if err == nil {
		return true
	}
	return false
}

type GoFileInfo struct {
	Name      string
	Size      int64
	ATime     int64
	MTime     int64
	CTime     int64
	BirthTime int64
	IsDir     bool
	Mode      os.FileMode
}

func StatsFn(p string) (GoFileInfo, error) {
	fileInfo, err := os.Stat(p)

	if err != nil {
		return GoFileInfo{}, err
	}

	t, _ := times.Stat(p)

	mTime := t.ModTime()
	aTime := t.AccessTime()

	cTime := mTime
	if t.HasChangeTime() {
		cTime = t.ChangeTime()
	}

	birthTime := cTime
	if t.HasBirthTime() {
		birthTime = t.BirthTime()
	}

	return GoFileInfo{
		Name:      fileInfo.Name(),
		Size:      fileInfo.Size(),
		ATime:     aTime.UnixNano(),
		MTime:     mTime.UnixNano(),
		CTime:     cTime.UnixNano(),
		BirthTime: birthTime.UnixNano(),
		IsDir:     fileInfo.IsDir(),
		Mode:      fileInfo.Mode(),
	}, nil
}

func ReadFileFn(p string) ([]byte, error) {
	stat, err := StatsFn(p)
	if err != nil {
		return nil, err
	}

	if stat.IsDir {
		return nil, errors.New("path is directory")
	}

	return os.ReadFile(p)
}

func WriteFileFn(p string, data []byte) error {
	return os.WriteFile(p, data, 0644)
}

func ReadDirFn(p string) ([]GoFileInfo, error) {
	items := []GoFileInfo{}

	entries, err := os.ReadDir(p)

	if err != nil {
		return items, err
	}

	for _, item := range entries {
		items = append(items, GoFileInfo{
			Name:  item.Name(),
			IsDir: item.IsDir(),
		})
	}

	return items, nil
}

func ReadDirFnRecursive(p string) ([]GoFileInfo, error) {
	items := []GoFileInfo{}

	err := filepath.WalkDir(p, func(itemPath string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		name, _ := filepath.Rel(p, itemPath)

		if name == "." {
			return nil
		}

		items = append(items, GoFileInfo{
			Name:  name,
			IsDir: d.IsDir(),
		})

		return nil
	})

	return items, err
}

func MkdirFn(p string) error {
	return os.MkdirAll(p, 0755)
}

func RmFn(p string) error {
	return os.RemoveAll(p)
}

func CreateFn(p string) (*os.File, error) {
	return os.Create(p)
}
