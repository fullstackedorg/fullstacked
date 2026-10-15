package fs

import (
	"errors"
	"fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
)

type FsFn = uint8

const (
	Exists            FsFn = 0
	Stats             FsFn = 1
	ReadFile          FsFn = 2
	ReadDir           FsFn = 3
	Mkdir             FsFn = 4
	Rm                FsFn = 5
	WriteFile         FsFn = 6
	Rename            FsFn = 7
	Copy              FsFn = 8
	CreateWriteStream FsFn = 9
	AppendFile        FsFn = 10
	CreateReadStream  FsFn = 11
)

func Switch(
	ctx *types.Context,
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
	case Mkdir:
		response.Type = types.CoreResponseData
		return MkdirFn(path.ResolveWithContext(ctx, data[0].Data.(string)))
	case Rm:
		response.Type = types.CoreResponseData
		return RmFn(path.ResolveWithContext(ctx, data[0].Data.(string)))
	case WriteFile:
		response.Type = types.CoreResponseData

		var contents []byte
		switch data[1].Type {
		case types.STRING:
			contents = []byte(data[1].Data.(string))
		case types.BUFFER:
			contents = data[1].Data.([]byte)
		}

		return WriteFileFn(path.ResolveWithContext(ctx, data[0].Data.(string)), contents)
	case AppendFile:
		response.Type = types.CoreResponseData

		var contents []byte
		switch data[1].Type {
		case types.STRING:
			contents = []byte(data[1].Data.(string))
		case types.BUFFER:
			contents = data[1].Data.([]byte)
		}

		return AppendFileFn(path.ResolveWithContext(ctx, data[0].Data.(string)), contents)
	case Rename:
		response.Type = types.CoreResponseData
		return RenameFn(path.ResolveWithContext(ctx, data[0].Data.(string)), path.ResolveWithContext(ctx, data[1].Data.(string)))
	case Copy:
		response.Type = types.CoreResponseData
		return CopyFn(path.ResolveWithContext(ctx, data[0].Data.(string)), path.ResolveWithContext(ctx, data[1].Data.(string)))
	case CreateWriteStream:
		filePath := path.ResolveWithContext(ctx, data[0].Data.(string))

		var file *os.File
		var openErr error
		openedChan := make(chan struct{})

		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				defer close(openedChan)
				dir := filepath.Dir(filePath)
				if !ExistsFn(dir) {
					MkdirFn(dir)
				}

				file, openErr = os.Create(filePath)
				if openErr != nil {
					store.StreamEvent(ctx, streamId, "error", []types.SerializableData{openErr.Error()}, true)
				}
			},
			Write: func(ctx *types.Context, streamId uint8, data []byte) {
				<-openedChan
				if openErr != nil {
					return
				}
				if file == nil {
					return
				}
				_, err := file.Write(data)
				if err != nil {
					store.StreamEvent(ctx, streamId, "error", []types.SerializableData{err.Error()}, true)
				}
			},
			Close: func(ctx *types.Context, streamId uint8) {
				<-openedChan
				if file != nil {
					file.Close()
					file = nil
				}
			},
		}
		return nil
	case CreateReadStream:
		// path, start, end (inclusive, -1 for the end of the file), chunk
		// size. The file is opened here so that an error rejects the call:
		// the stream carries the bytes only.
		if len(data) < 4 {
			return errors.New("createReadStream requires path, start, end and chunk size")
		}
		filePath := path.ResolveWithContext(ctx, data[0].Data.(string))
		start := int64(data[1].Data.(float64))
		end := int64(data[2].Data.(float64))
		chunkSize := int(data[3].Data.(float64))
		if chunkSize <= 0 {
			chunkSize = 64 * 1024
		}

		file, err := os.Open(filePath)
		if err != nil {
			return err
		}
		if start > 0 {
			if _, err := file.Seek(start, io.SeekStart); err != nil {
				file.Close()
				return err
			}
		}

		reading := &fileReading{}
		closeFile := sync.OnceFunc(func() { file.Close() })

		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				defer closeFile()
				readFileStream(ctx, streamId, file, start, end, chunkSize, reading)
			},
			// the core removes the stream right after: once this returns,
			// the reader pushes nothing more (a chunk for a removed stream
			// is a panic of store.StreamChunk)
			Close: func(ctx *types.Context, streamId uint8) {
				reading.mu.Lock()
				reading.closed = true
				reading.mu.Unlock()
				closeFile()
			},
		}
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

	atime, mtime, ctime, birthtime := getStatTimes(p, fileInfo)
	perm := fileInfo.Mode().Perm()
	if runtime.GOOS == "windows" {
		perm = perm & 0666
	}

	return GoFileInfo{
		Name:      fileInfo.Name(),
		Size:      fileInfo.Size(),
		ATime:     atime,
		MTime:     mtime,
		CTime:     ctime,
		BirthTime: birthtime,
		IsDir:     fileInfo.IsDir(),
		Mode:      perm,
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

func AppendFileFn(p string, data []byte) error {
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(data)
	return err
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

	if runtime.GOOS == "windows" {
		slices.SortFunc(items, func(a GoFileInfo, b GoFileInfo) int {
			return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
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

func RenameFn(p string, p2 string) error {
	return os.Rename(p, p2)
}
func CopyFn(src string, dst string) error {
	srcStat, err := os.Stat(src)
	if err != nil {
		return err
	}

	if !srcStat.IsDir() {
		return copyFileFn(src, dst)
	}

	err = os.MkdirAll(dst, srcStat.Mode())
	if err != nil {
		return err
	}

	entries, err := os.ReadDir(src)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())

		err = CopyFn(srcPath, dstPath)
		if err != nil {
			return err
		}
	}

	return nil
}

func copyFileFn(src string, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}

	srcStat, err := os.Stat(src)
	if err != nil {
		return err
	}

	dir := filepath.Dir(dst)
	if !ExistsFn(dir) {
		MkdirFn(dir)
	}

	return os.WriteFile(dst, data, srcStat.Mode())
}

// streams the bytes [start, end] of an open file in chunks of chunkSize,
// the end with the last chunk; the frames backpressure blocks it while the
// page is behind, closed stops it when the page destroys the stream. A read
// error ends the stream early (the page sees fewer bytes).
func readFileStream(
	ctx *types.Context,
	streamId uint8,
	file *os.File,
	start int64,
	end int64,
	chunkSize int,
	reading *fileReading,
) {
	remaining := int64(-1)
	if end >= 0 {
		remaining = end - max(start, 0) + 1
		if remaining <= 0 {
			store.StreamChunk(ctx, streamId, nil, true)
			return
		}
	}

	chunk := make([]byte, chunkSize)
	for {
		size := chunkSize
		if remaining >= 0 && int64(size) > remaining {
			size = int(remaining)
		}
		n, err := io.ReadFull(file, chunk[:size])
		if remaining >= 0 {
			remaining -= int64(n)
		}
		last := err != nil || remaining == 0
		reading.mu.Lock()
		if reading.closed {
			reading.mu.Unlock()
			return
		}
		store.StreamChunk(ctx, streamId, chunk[:n], last)
		reading.mu.Unlock()
		if last {
			return
		}
	}
}

// closed by the page (the stream's Close), under the lock of the pushes
type fileReading struct {
	mu     sync.Mutex
	closed bool
}
