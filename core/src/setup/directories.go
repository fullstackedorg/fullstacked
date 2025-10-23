package setup

import "path/filepath"

type DirectoriesStruct struct {
	Root   string
	Config string
	Editor string
	Tmp    string
}

var Directories *DirectoriesStruct = nil

func SetupDirectories(
	root string,
	config string,
	editor string,
	tmp string,
) {
	Directories = &DirectoriesStruct{
		Root:   filepath.ToSlash(root),
		Config: filepath.ToSlash(config),
		Editor: filepath.ToSlash(editor),
		Tmp:    filepath.ToSlash(tmp),
	}
}
