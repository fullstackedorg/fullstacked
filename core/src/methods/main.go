package methods

import (
	"encoding/json"
	"path"
	"path/filepath"
	"slices"
	"strings"

	archive "fullstackedorg/fullstacked/src/archive"
	build "fullstackedorg/fullstacked/src/build"
	config "fullstackedorg/fullstacked/src/config"
	connect "fullstackedorg/fullstacked/src/connect"
	fetch "fullstackedorg/fullstacked/src/fetch"
	fs "fullstackedorg/fullstacked/src/fs"
	git "fullstackedorg/fullstacked/src/git"
	ts_lsp "fullstackedorg/fullstacked/src/lsp"
	packages "fullstackedorg/fullstacked/src/packages"
	serialize "fullstackedorg/fullstacked/src/serialize"
	setup "fullstackedorg/fullstacked/src/setup"
	staticFiles "fullstackedorg/fullstacked/src/staticFiles"
	utils "fullstackedorg/fullstacked/src/utils"
)

const (
	HELLO       = 0
	STATIC_FILE = 1

	FS_READFILE  = 2
	FS_WRITEFILE = 3
	FS_UNLINK    = 4
	FS_READDIR   = 5
	FS_MKDIR     = 6
	FS_RMDIR     = 7
	FS_EXISTS    = 8
	FS_RENAME    = 9
	FS_STAT      = 10

	FETCH  = 15
	FETCH2 = 16

	CONNECT      = 20
	CONNECT_SEND = 21

	ARCHIVE_UNZIP_BIN_TO_FILE  = 30
	ARCHIVE_UNZIP_BIN_TO_BIN   = 31
	ARCHIVE_UNZIP_FILE_TO_FILE = 32
	ARCHIVE_UNZIP_FILE_TO_BIN  = 33

	ARCHIVE_ZIP_BIN_TO_FILE  = 34
	ARCHIVE_ZIP_BIN_TO_BIN   = 35
	ARCHIVE_ZIP_FILE_TO_FILE = 36
	ARCHIVE_ZIP_FILE_TO_BIN  = 37

	SET_TITLE = 40

	DIRECTORY_ROOT = 45

	CONFIG_GET  = 50
	CONFIG_SAVE = 51

	ESBUILD_VERSION     = 55
	BUILD_PROJECT       = 56
	BUILD_SHOULD_BUILD  = 57
	BUILD_SASS_RESPONSE = 58

	PACKAGE_INSTALL       = 60
	PACKAGE_INSTALL_QUICK = 61

	FULLSTACKED_MODULES_FILE = 65
	FULLSTACKED_MODULES_LIST = 66

	GIT_CLONE         = 70
	GIT_HEAD          = 71
	GIT_STATUS        = 72
	GIT_PULL          = 73
	GIT_RESTORE       = 74
	GIT_CHECKOUT      = 75
	GIT_FETCH         = 76
	GIT_COMMIT        = 77
	GIT_BRANCHES      = 78
	GIT_PUSH          = 79
	GIT_BRANCH_DELETE = 80
	GIT_AUTH_RESPONSE = 81
	GIT_HAS_GIT       = 82
	GIT_REMOTE_URL    = 83

	LSP_START   = 90
	LSP_REQUEST = 91
	LSP_END     = 92
	LSP_VERSION = 93

	OPEN = 100
)

var EDITOR_ONLY = []int{
	CONFIG_GET,
	CONFIG_SAVE,

	ESBUILD_VERSION,
	// BUILD_PROJECT,
	BUILD_SHOULD_BUILD,

	DIRECTORY_ROOT,

	PACKAGE_INSTALL,
	// PACKAGE_INSTALL_QUICK,

	FULLSTACKED_MODULES_FILE,
	FULLSTACKED_MODULES_LIST,

	GIT_CLONE,
	GIT_HEAD,
	GIT_STATUS,
	// GIT_PULL,
	GIT_RESTORE,
	GIT_CHECKOUT,
	GIT_FETCH,
	GIT_COMMIT,
	GIT_BRANCHES,
	GIT_PUSH,
	GIT_BRANCH_DELETE,
	GIT_AUTH_RESPONSE,
	// GIT_HAS_GIT,
	// GIT_REMOTE_URL,

	OPEN,
}

func Call(payload []byte) []byte {
	cursor := 0

	isEditor := payload[cursor] == 1
	cursor++

	projectIdLength := serialize.DeserializeBytesToInt(payload[cursor : cursor+4])
	cursor += 4

	projectId := string(payload[cursor : cursor+projectIdLength])
	cursor += projectIdLength

	method := int(payload[cursor])
	cursor++

	args := serialize.DeserializeArgs(payload[cursor:])

	baseDir := setup.Directories.Root + "/" + projectId
	if isEditor {
		baseDir = setup.Directories.Root
	}

	if slices.Contains(EDITOR_ONLY, method) && !isEditor {
		return nil
	}

	switch {
	case method == HELLO:
		setup.Callback(projectId, "hello", "Hello From Go")
	case method == STATIC_FILE:
		if isEditor {
			baseDir = setup.Directories.Editor
		}
		return staticFiles.Serve(baseDir, args[0].(string))
	case method >= 2 && method <= 10:
		return fsSwitch(method, baseDir, args)
	case method == FETCH:
		headers := (map[string]string)(nil)
		if args[3].(string) != "" {
			_ = json.Unmarshal([]byte(args[3].(string)), &headers)
		}

		go fetch.FetchSerialized(
			projectId,
			args[0].(float64),
			args[1].(string),
			args[2].(string),
			&headers,
			args[4].([]byte),
			int(args[5].(float64)),
			args[6].(bool),
		)
	case method == FETCH2:
		headers := (map[string]string)(nil)
		if args[3].(string) != "" {
			_ = json.Unmarshal([]byte(args[3].(string)), &headers)
		}

		go fetch.Fetch2(
			projectId,
			args[0].(float64),
			args[1].(string),
			args[2].(string),
			&headers,
			args[4].([]byte),
		)
	case method == CONNECT:
		channelId := connect.Connect(projectId, args[0].(string), args[1].(float64), args[2].(string), args[3].(bool))
		return serialize.SerializeString(channelId)
	case method == CONNECT_SEND:
		connect.Send(args[0].(string), args[1].([]byte))
		return nil
	case method == SET_TITLE:
		setup.Callback(projectId, "title", args[0].(string))
		return nil
	case method >= 30 && method <= 37:
		return archiveSwitch(isEditor, method, baseDir, args)
	case method == DIRECTORY_ROOT:
		return serialize.SerializeString(utils.RemoveDriveLetter(filepath.ToSlash(setup.Directories.Root)))
	case method == CONFIG_GET:
		return config.GetSerialized(args[0].(string))
	case method == CONFIG_SAVE:
		return config.SaveSerialized(args[0].(string), args[1].(string))
	case method == ESBUILD_VERSION:
		return serialize.SerializeString(build.EsbuildVersion())
	case method == BUILD_PROJECT:
		buildProjectId := projectId
		buildId := 0.0

		if isEditor {
			buildProjectId = args[0].(string)
			buildId = args[1].(float64)
		} else {
			buildId = args[0].(float64)
		}

		go build.Build(buildProjectId, buildId, projectId)
	case method == BUILD_SASS_RESPONSE:
		styleBuildResult := build.StyleBuildResult{}
		json.Unmarshal([]byte(args[1].(string)), &styleBuildResult)
		build.StyleBuildResponse(args[0].(string), styleBuildResult)
	case method == BUILD_SHOULD_BUILD:
		projectDirectory := setup.Directories.Root + "/" + args[0].(string)
		return serialize.SerializeBoolean(build.ShouldBuild(projectDirectory))
	case method == PACKAGE_INSTALL:
		projectDirectory := setup.Directories.Root + "/" + args[0].(string)
		installationId := args[1].(float64)
		packagesToInstall := []string{}
		for i, p := range args {
			if i < 3 {
				continue
			}
			packagesToInstall = append(packagesToInstall, p.(string))
		}
		go packages.Install(installationId, projectDirectory, args[2].(bool), packagesToInstall)
	case method == PACKAGE_INSTALL_QUICK:
		projectDirectory := path.Join(setup.Directories.Root, projectId)
		installationId := 0.0

		if isEditor {
			projectDirectory = path.Join(setup.Directories.Root, args[0].(string))
			installationId = args[1].(float64)
		} else {
			installationId = args[0].(float64)
		}

		go packages.InstallQuick(projectId, installationId, projectDirectory)
	case method == OPEN:
		setup.Callback("", "open", args[0].(string))
		return nil
	case method >= 70 && method <= 83:
		return gitSwitch(isEditor, projectId, method, args)
	case method == FULLSTACKED_MODULES_FILE:
		filePath := args[0].(string)
		if !strings.HasPrefix(filePath, "fullstacked_modules") {
			return nil
		}
		filePathAbs := path.Join(setup.Directories.Editor, filePath)
		_, isFile := fs.Exists(filePathAbs)
		if !isFile {
			return nil
		}
		return fs.ReadFileSerialized(filePathAbs, true)
	case method == FULLSTACKED_MODULES_LIST:
		return fs.ReadDirSerialized(path.Join(setup.Directories.Editor, "fullstacked_modules"), true, false, false, []string{})
	case method == LSP_START:
		return serialize.SerializeString(ts_lsp.Start(path.Join(setup.Directories.Root, args[0].(string))))
	case method == LSP_REQUEST:
		ts_lsp.Request(args[0].(string), args[1].(string))
	case method == LSP_END:
		ts_lsp.End(args[0].(string))
	case method == LSP_VERSION:
		return serialize.SerializeString(ts_lsp.Version())
	}

	return nil
}

func fsSwitch(method int, baseDir string, args []any) []byte {
	fileName := ""
	if args[0] != nil {
		fileName = args[0].(string)
	}

	filePath := path.Join(baseDir, fileName)

	switch method {
	case FS_READFILE:
		return fs.ReadFileSerialized(filePath, args[1].(bool))
	case FS_WRITEFILE:
		fileEventOrigin := ""
		if len(args) > 2 {
			fileEventOrigin = args[2].(string)
		}
		return fs.WriteFileSerialized(filePath, args[1].([]byte), fileEventOrigin)
	case FS_UNLINK:
		fileEventOrigin := ""
		if len(args) > 1 {
			fileEventOrigin = args[1].(string)
		}
		return fs.UnlinkSerialized(filePath, fileEventOrigin)
	case FS_READDIR:
		skip := []string{}
		if len(args) > 3 {
			for _, arg := range args[4:] {
				skip = append(skip, arg.(string))
			}
		}
		return fs.ReadDirSerialized(filePath, args[1].(bool), args[2].(bool), args[3].(bool), skip)
	case FS_MKDIR:
		fileEventOrigin := ""
		if len(args) > 1 {
			fileEventOrigin = args[1].(string)
		}
		return fs.MkdirSerialized(filePath, fileEventOrigin)
	case FS_RMDIR:
		fileEventOrigin := ""
		if len(args) > 1 {
			fileEventOrigin = args[1].(string)
		}
		return fs.RmdirSerialized(filePath, fileEventOrigin)
	case FS_EXISTS:
		return fs.ExistsSerialized(filePath)
	case FS_RENAME:
		fileEventOrigin := ""
		if len(args) > 2 {
			fileEventOrigin = args[2].(string)
		}
		newPath := path.Join(baseDir, args[1].(string))
		return fs.RenameSerialized(filePath, newPath, fileEventOrigin)
	case FS_STAT:
		return fs.StatSerialized(filePath)
	}

	return nil
}

func gitSwitch(isEditor bool, projectId string, method int, args []any) []byte {
	directory := path.Join(setup.Directories.Root, projectId)

	// most git methods uses the directory as first argument
	if isEditor && len(args) > 0 {
		directory = path.Join(setup.Directories.Root, args[0].(string))
	}

	switch method {
	case GIT_CLONE:
		go git.Clone(directory, args[1].(string))
	case GIT_HEAD:
		return git.HeadSerialized(directory)
	case GIT_STATUS:
		return git.Status(directory)
	case GIT_PULL:
		go git.Pull(directory, isEditor, projectId)
	case GIT_PUSH:
		go git.Push(directory)
	case GIT_RESTORE:
		files := []string{}
		for _, file := range args[1:] {
			files = append(files, file.(string))
		}
		return git.Restore(directory, files)
	case GIT_CHECKOUT:
		return git.Checkout(directory, args[1].(string), args[2].(bool))
	case GIT_FETCH:
		return git.Fetch(directory)
	case GIT_COMMIT:
		return git.Commit(directory, args[1].(string), args[2].(string), args[3].(string))
	case GIT_BRANCHES:
		return git.Branches(directory)
	case GIT_BRANCH_DELETE:
		return git.BranchDelete(directory, args[1].(string))
	case GIT_AUTH_RESPONSE:
		git.AuthResponse(args[0].(string), args[1].(bool))
	case GIT_HAS_GIT:
		return serialize.SerializeBoolean(git.HasGit(directory))
	case GIT_REMOTE_URL:
		return serialize.SerializeString(git.RemoteURL(directory))
	}

	return nil
}

func archiveSwitch(isEditor bool, method int, baseDir string, args []any) []byte {
	switch method {
	case ARCHIVE_UNZIP_BIN_TO_FILE:
		entry := args[0].([]byte)
		out := path.Join(baseDir, args[1].(string))

		// Android and WASM uses this to unzip
		if len(args) > 2 && isEditor && args[2].(bool) {
			out = args[1].(string)
		}

		return archive.UnzipDataToFilesSerialized(entry, out)
	case ARCHIVE_UNZIP_BIN_TO_BIN:
		entry := args[0].([]byte)
		return archive.UnzipDataToDataSerialized(entry)
	case ARCHIVE_UNZIP_FILE_TO_FILE:
		entry := path.Join(baseDir, args[0].(string))
		out := path.Join(baseDir, args[1].(string))
		return archive.UnzipFileToFilesSerialized(entry, out)
	case ARCHIVE_UNZIP_FILE_TO_BIN:
		entry := args[0].(string)
		return archive.UnzipFileToDataSerialized(entry)
	case ARCHIVE_ZIP_BIN_TO_FILE:
		out := path.Join(baseDir, args[0].(string))
		entries := archive.SerializedArgsToFileEntries(args[1:])
		return archive.ZipDataToFileSerialized(entries, out)
	case ARCHIVE_ZIP_BIN_TO_BIN:
		entries := archive.SerializedArgsToFileEntries(args)
		return archive.ZipDataToDataSerialized(entries)
	case ARCHIVE_ZIP_FILE_TO_FILE:
		entry := path.Join(baseDir, args[0].(string))
		out := path.Join(baseDir, args[1].(string))
		skip := []string{}
		if len(args) > 2 {
			for i := 2; i < len(args); i++ {
				skip = append(skip, args[i].(string))
			}
		}
		return archive.ZipFileToFileSerialized(entry, out, skip)
	case ARCHIVE_ZIP_FILE_TO_BIN:
		entry := path.Join(baseDir, args[0].(string))
		skip := []string{}
		if len(args) > 1 {
			for i := 1; i < len(args); i++ {
				skip = append(skip, args[i].(string))
			}
		}
		return archive.ZipFileToDataSerialized(entry, skip)
	}

	return nil
}
