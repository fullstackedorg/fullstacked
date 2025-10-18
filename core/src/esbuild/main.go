package esbuild

import (
	"encoding/json"
	fs "fullstackedorg/fullstacked/core/src/fs"
	"fullstackedorg/fullstacked/core/src/git"
	setup "fullstackedorg/fullstacked/core/src/setup"
	utils "fullstackedorg/fullstacked/core/src/utils"
	"path"
	"path/filepath"
	"runtime/debug"
	"strings"

	esbuild "github.com/evanw/esbuild/pkg/api"
)

var fileEventOrigin = "esbuild"

func Version() string {
	bi, _ := debug.ReadBuildInfo()

	for _, dep := range bi.Deps {
		if strings.HasSuffix(dep.Path, "esbuild") {
			return dep.Version
		}
	}

	return ""
}

func findEntryPoint(directory string) *string {
	possibleEntryPoints := []string{
		"index.js",
		"index.jsx",
		"index.ts",
		"index.tsx",
	}

	items, _ := fs.ReadDir(directory, false, true, []string{})

	entryPoint := (*string)(nil)

	for _, possibleEntry := range possibleEntryPoints {

		for _, item := range items {
			if strings.HasSuffix(item.Name, possibleEntry) {
				entryPoint = &item.Name
				break
			}
		}

		if entryPoint != nil {
			break
		}
	}

	return entryPoint
}

func ShouldBuild(projectDirectory string) bool {
	if !git.HasGit(projectDirectory) {
		return true
	}

	lastBuildCommitFilePath := path.Join(projectDirectory, ".build", ".commit")
	_, isFile := fs.Exists(lastBuildCommitFilePath)

	if !isFile {
		return true
	}

	lastBuildCommit, err := fs.ReadFile(lastBuildCommitFilePath)

	if err != nil {
		return true
	}

	head, err := git.Head(projectDirectory)

	if err != nil {
		return true
	}

	currentCommit := head.Hash().String()

	return string(lastBuildCommit) != currentCommit
}

type BuildResult struct {
	Id     float64           `json:"id"`
	Errors []esbuild.Message `json:"errors"`
}

func Build(
	projectId string,
	projectDirectory string,
	buildId float64,
) BuildResult {
	// find entryPoints
	entryPointJS := findEntryPoint(projectDirectory)
	entryPointAbsCSS := filepath.ToSlash(path.Join(projectDirectory, ".build", "index.css"))

	// create tmp that imports bridge and entryPoint if any
	tmpFile := path.Join(setup.Directories.Tmp, utils.RandString(10)+".js")
	if entryPointJS == nil {
		fs.WriteFile(tmpFile, []byte(`
			import "`+entryPointAbsCSS+`";
			import "components/snackbar.css";
			import "bridge";
		`), fileEventOrigin)
	} else {
		entryPointAbs := filepath.ToSlash(path.Join(projectDirectory, *entryPointJS))

		fs.WriteFile(tmpFile, []byte(`
			import "`+entryPointAbsCSS+`";
			import "components/snackbar.css";
			import "bridge";
			import "`+entryPointAbs+`";
		`), fileEventOrigin)
	}

	// add WASM fixture plugin
	plugins := []esbuild.Plugin{}
	if fs.WASM {
		wasmFS := esbuild.Plugin{
			Name: "wasm-fs",
			Setup: func(build esbuild.PluginBuild) {
				build.OnResolve(esbuild.OnResolveOptions{Filter: `.*`},
					func(args esbuild.OnResolveArgs) (esbuild.OnResolveResult, error) {
						if strings.HasPrefix(args.Path, "/") {
							return esbuild.OnResolveResult{
								Path: args.Path,
							}, nil
						}

						resolved := vResolve(projectDirectory, args.ResolveDir, args.Path)

						if resolved == nil {
							return esbuild.OnResolveResult{}, nil
						}

						resolvedStr := *resolved
						if !strings.HasPrefix(resolvedStr, "/") {
							resolvedStr = "/" + resolvedStr
						}

						return esbuild.OnResolveResult{
							Path: resolvedStr,
						}, nil
					})

				build.OnLoad(esbuild.OnLoadOptions{Filter: `.*`},
					func(args esbuild.OnLoadArgs) (esbuild.OnLoadResult, error) {
						contents, _ := fs.ReadFile(args.Path)
						contentsStr := string(contents)

						loader := inferLoader(args.Path)

						return esbuild.OnLoadResult{
							Contents: &contentsStr,
							Loader:   loader,
						}, nil
					})
			},
		}
		plugins = append(plugins, wasmFS)
	}

	// build
	result := esbuild.Build(esbuild.BuildOptions{
		EntryPointsAdvanced: []esbuild.EntryPoint{{
			InputPath:  filepath.ToSlash(tmpFile),
			OutputPath: "index",
		}},
		AllowOverwrite: true,
		Outdir:         projectDirectory + "/.build",
		Splitting:      !fs.WASM,
		Bundle:         true,
		Format:         esbuild.FormatESModule,
		Sourcemap:      esbuild.SourceMapInlineAndExternal,
		Write:          false,
		Plugins:        plugins,
		NodePaths: []string{
			path.Join(setup.Directories.Root, ".fullstacked_modules"),
			path.Join(projectDirectory, "node_modules"),
		},
	})

	for _, file := range result.OutputFiles {
		fs.WriteFile(file.Path, file.Contents, fileEventOrigin)
	}

	if len(result.Errors) == 0 && git.HasGit(projectDirectory) {
		head, err := git.Head(projectDirectory)
		if err == nil {
			cacheCommitFile := path.Join(projectDirectory, ".build", ".commit")
			fs.WriteFile(cacheCommitFile, []byte(head.Hash().String()), fileEventOrigin)
		}
	}

	buildResult := BuildResult{
		Id:     buildId,
		Errors: result.Errors,
	}
	jsonMessages, _ := json.Marshal(buildResult)

	setup.Callback(projectId, "build", string(jsonMessages))
	fs.Unlink(tmpFile, fileEventOrigin)

	return buildResult
}
