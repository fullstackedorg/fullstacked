package staticFiles

import (
	"mime"
	"net/url"
	"path"
	"strings"

	"fullstackedorg/fullstacked/src/build"
	fs "fullstackedorg/fullstacked/src/fs"
	serialize "fullstackedorg/fullstacked/src/serialize"
)

func Serve(baseDir string, filePath string) []byte {
	filePath, _ = url.PathUnescape(filePath)
	filePath = strings.TrimLeft(filePath, "/")
	filePath = strings.TrimRight(filePath, "/")

	// check if file exists
	filePathAbs := path.Join(baseDir, filePath)
	exists, isFile := fs.Exists(filePathAbs)

	// then try in .build directory,
	// if exists, use this
	buildDir := path.Join(baseDir, ".build")
	buildFilePathAbs := path.Join(buildDir, filePath)
	buildFileExists, buildFileIsFile := fs.Exists(buildFilePathAbs)
	if buildFileExists && buildFileIsFile {
		filePathAbs = buildFilePathAbs
		isFile = buildFileIsFile
		exists = buildFileExists
	}

	if !exists {
		return nil
	}

	// path is directory,
	// look for index.html
	// if exists, parse and inject `<script type="module" src="/index.js"></script>`
	// else, send base HTML index file that includes `<script type="module" src="/index.js"></script>`
	if !isFile {
		data := serialize.SerializeString("text/html")
		data = append(data, serialize.SerializeBuffer(build.SetupHTML(path.Join(filePathAbs, "index.html")))...)
		return data
	}

	fileExtComponents := strings.Split(filePathAbs, ".")
	ext := fileExtComponents[len(fileExtComponents)-1]

	mimeType := strings.Split(mime.TypeByExtension("."+ext), ";")[0]

	// file types fix
	switch ext {
	case "mjs", "cjs":
		mimeType = strings.Split(mime.TypeByExtension(".js"), ";")[0]
	case "woff2":
		mimeType = "font/woff2"
	}

	if mimeType == "" {
		mimeType = "text/plain"
	}

	data := serialize.SerializeString(mimeType)
	data = append(data, fs.ReadFileSerialized(filePathAbs, false)...)

	return data
}
