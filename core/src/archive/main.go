package archive

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"path"
	"path/filepath"
	"strings"

	fs "fullstackedorg/fullstacked/src/fs"
	serialize "fullstackedorg/fullstacked/src/serialize"
)

var fileEventOrigin = "archive"

func SerializedArgsToFileEntries(args []any) []FileEntry {
	entries := []FileEntry{}
	for i := 0; i < len(args); i += 3 {
		entries = append(entries, FileEntry{
			Name:  args[i].(string),
			IsDir: args[i+1].(bool),
			Data:  args[i+2].([]byte),
		})
	}
	return entries
}

func FileToData(in string) ([]byte, error) {
	exists, isFile := fs.Exists(in)

	if !exists {
		return nil, errors.New("zip file does not exist")
	} else if !isFile {
		return nil, errors.New("zip entry is not a file")
	}

	return fs.ReadFile(in)
}

func UnzipDataToFilesSerialized(data []byte, out string) []byte {
	zipReader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return serialize.SerializeError(err)
	}

	CleanOut(out)
	fs.Mkdir(out, fileEventOrigin)

	for _, zipFile := range zipReader.File {
		if zipFile.FileInfo().IsDir() {
			fs.Mkdir(out+"/"+zipFile.Name, fileEventOrigin)
		} else {
			data, err := readZipFile(zipFile)
			if err != nil {
				continue
			}
			err = fs.WriteFile(out+"/"+zipFile.Name, data, fileEventOrigin)
			if err != nil {
				continue
			}
		}
	}

	return serialize.SerializeBoolean(true)
}

func UnzipFileToFilesSerialized(in string, out string) []byte {
	data, err := FileToData(in)

	if err != nil {
		return serialize.SerializeError(err)
	}

	return UnzipDataToFilesSerialized(data, out)
}

func UnzipDataToDataSerialized(data []byte) []byte {
	out := []byte{}

	zipReader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return serialize.SerializeError(err)
	}

	for _, zipFile := range zipReader.File {
		if zipFile.FileInfo().IsDir() {
			out = append(out, serialize.SerializeString(zipFile.Name)...)
			out = append(out, serialize.SerializeBoolean(true)...)
			out = append(out, serialize.SerializeBuffer([]byte{})...)
		} else {
			data, err := readZipFile(zipFile)
			if err != nil {
				continue
			}
			out = append(out, serialize.SerializeString(zipFile.Name)...)
			out = append(out, serialize.SerializeBoolean(false)...)
			out = append(out, serialize.SerializeBuffer(data)...)
		}
	}

	return out
}

func UnzipFileToDataSerialized(in string) []byte {
	data, err := FileToData(in)

	if err != nil {
		return serialize.SerializeError(err)
	}

	return UnzipDataToDataSerialized(data)
}

type FileEntry struct {
	Name  string
	IsDir bool
	Data  []byte
}

func Zip(entries []FileEntry) []byte {
	acc := inMemoryZipData{}
	w := zip.NewWriter(&acc)

	for _, f := range entries {
		if f.IsDir {
			w.Create(f.Name + "/")
		} else {
			zipFile, _ := w.Create(f.Name)
			zipFile.Write(f.Data)
		}
	}
	w.Close()

	return acc.data
}

func CleanOut(out string) {
	exists, isFile := fs.Exists(out)

	if exists {
		if isFile {
			fs.Unlink(out, fileEventOrigin)
		} else {
			fs.Rmdir(out, fileEventOrigin)
		}
	}

	outDir := filepath.Dir(out)
	fs.Mkdir(outDir, fileEventOrigin)
}

func ZipDataToFileSerialized(entries []FileEntry, out string) []byte {
	CleanOut(out)
	return fs.WriteFileSerialized(out, Zip(entries), fileEventOrigin)
}

func ZipDataToDataSerialized(entries []FileEntry) []byte {
	return serialize.SerializeBuffer(Zip(entries))
}

func DirectoryToFileEntries(in string, skip []string) ([]FileEntry, error) {
	exists, isFile := fs.Exists(in)

	if !exists {
		return nil, errors.New("directory to zip does not exist")
	} else if isFile {
		return nil, errors.New("directory to zip is not a directory")
	}

	files, err := fs.ReadDir(in, true, false, []string{})

	if err != nil {
		return nil, err
	}

	entries := []FileEntry{}

	for _, f := range files {

		mustSkip := false
		for _, p := range skip {
			if strings.HasPrefix(f.Name, p) {
				mustSkip = true
				break
			}
		}
		if mustSkip {
			continue
		}

		data := ([]byte)(nil)
		if !f.IsDir {
			data, err = fs.ReadFile(path.Join(in, f.Name))
			if err != nil {
				continue
			}
		}

		entries = append(entries, FileEntry{
			Name:  f.Name,
			IsDir: f.IsDir,
			Data:  data,
		})
	}

	return entries, nil
}

func ZipFileToFileSerialized(in string, out string, skip []string) []byte {
	entries, err := DirectoryToFileEntries(in, skip)

	if err != nil {
		return serialize.SerializeError(err)
	}

	CleanOut(out)

	zipData := Zip(entries)
	return fs.WriteFileSerialized(out, zipData, fileEventOrigin)
}

func ZipFileToDataSerialized(in string, skip []string) []byte {
	entries, err := DirectoryToFileEntries(in, skip)

	if err != nil {
		return serialize.SerializeError(err)
	}

	return serialize.SerializeBuffer(Zip(entries))
}

func readZipFile(zf *zip.File) ([]byte, error) {
	f, err := zf.Open()
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return io.ReadAll(f)
}

type inMemoryZipData struct {
	data []byte
}

func (w *inMemoryZipData) Write(chunk []byte) (n int, err error) {
	w.data = append(w.data, chunk...)
	return len(chunk), nil
}
