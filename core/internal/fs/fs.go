package fs

import (
	"errors"
	"fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/types"
	"os"

	"github.com/djherbis/times"
)

type FsFn = uint8

const (
	Exists   FsFn = 0
	Stats    FsFn = 1
	ReadFile FsFn = 2
)

func Switch(
	ctx *types.CoreCallContext,
	fn FsFn,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch fn {
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
		birthTime = t.BirthTime();
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
