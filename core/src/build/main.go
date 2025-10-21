package build

import (
	"encoding/json"
	"fmt"
	fs "fullstackedorg/fullstacked/src/fs"
	"fullstackedorg/fullstacked/src/git"
	setup "fullstackedorg/fullstacked/src/setup"
	"fullstackedorg/fullstacked/src/utils"
	"path"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"

	esbuild "github.com/evanw/esbuild/pkg/api"
)

var fileEventOrigin = "build"

func EsbuildVersion() string {
	bi, _ := debug.ReadBuildInfo()

	for _, dep := range bi.Deps {
		if strings.HasSuffix(dep.Path, "esbuild") {
			return dep.Version
		}
	}

	return ""
}

func findEntryPoint(directory string, filenames []string) *string {
	items, _ := fs.ReadDir(directory, false, false, []string{})

	entryPoint := (*string)(nil)

	for _, possibleEntry := range filenames {

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

type ProjectBuild struct {
	BuildID   float64
	ProjectID string
	OriginID  string
}

type BuildResult struct {
	Id     float64           `json:"id"`
	Errors []esbuild.Message `json:"errors"`
}

func Build(
	projectId string,
	buildId float64,
	originId string,
) BuildResult {
	projectBuild := ProjectBuild{
		BuildID:   buildId,
		ProjectID: projectId,
		OriginID:  originId,
	}

	return projectBuild.Build()
}

type StyleBuildResult struct {
	Errors []esbuild.Message `json:"errors"`
	Css    string            `json:"css"`
}

type StyleBuild struct {
	ID         string           `json:"id"`
	ProjectID  string           `json:"projectId"`
	EntryPoint string           `json:"entryPoint"`
	Wg         *sync.WaitGroup  `json:"-"`
	Result     StyleBuildResult `json:"result"`
}

var activeStyleBuild = map[string]*StyleBuild{}

func StyleBuildResponse(id string, result StyleBuildResult) {
	styleBuild, ok := activeStyleBuild[id]

	if !ok {
		fmt.Println("cannot find active style build")
		return
	}

	styleBuild.Result = result

	styleBuild.Wg.Done()
}

func (p *ProjectBuild) buildStyle(entryPoint string) StyleBuildResult {
	filePath := path.Join(setup.Directories.Root, p.ProjectID, entryPoint)

	_, isFile := fs.Exists(filePath)

	if !isFile {
		return StyleBuildResult{
			Errors: []esbuild.Message{
				{
					Text: "cannot find entrypoint",
				},
			},
		}
	}

	wg := &sync.WaitGroup{}
	styleBuild := StyleBuild{
		ID:         utils.RandString(6),
		ProjectID:  p.ProjectID,
		EntryPoint: entryPoint,
		Wg:         wg,
	}
	activeStyleBuild[styleBuild.ID] = &styleBuild
	defer delete(activeStyleBuild, styleBuild.ID)

	styleBuild.Wg.Add(1)

	jsonData, _ := json.Marshal(styleBuild)
	jsonStr := string(jsonData)
	setup.Callback(p.OriginID, "build-style", jsonStr)

	styleBuild.Wg.Wait()

	return styleBuild.Result
}

func (p *ProjectBuild) buildJS(entryPoint string, styleEntryPoint *string) esbuild.BuildResult {
	intermediateFilePath := path.Join(setup.Directories.Tmp, utils.RandString(10)+".js")
	entryPointJSPath := path.Join(setup.Directories.Root, p.ProjectID, entryPoint)

	if styleEntryPoint == nil {
		fs.WriteFile(intermediateFilePath, []byte(`
			import "bridge";
			import "`+entryPointJSPath+`"
		`), fileEventOrigin)
	} else {
		fs.WriteFile(intermediateFilePath, []byte(`
			import "`+*styleEntryPoint+`";
			import "bridge";
			import "`+entryPointJSPath+`";
		`), fileEventOrigin)
	}

	projectDirectory := path.Join(setup.Directories.Root, p.ProjectID)

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
	fullstackedModulesDir := findEntryPoint(setup.Directories.Root, []string{
		"fullstacked_modules",
		".fullstacked_modules",
	})

	result := esbuild.Build(esbuild.BuildOptions{
		EntryPointsAdvanced: []esbuild.EntryPoint{{
			InputPath:  filepath.ToSlash(intermediateFilePath),
			OutputPath: "index",
		}},
		AllowOverwrite: true,
		Splitting:      !fs.WASM,
		Outdir:         "/",
		Bundle:         true,
		Format:         esbuild.FormatESModule,
		Sourcemap:      esbuild.SourceMapInlineAndExternal,
		Write:          false,
		Plugins:        plugins,
		NodePaths: []string{
			path.Join(setup.Directories.Root, *fullstackedModulesDir),
			path.Join(projectDirectory, "node_modules"),
		},
	})

	fs.Unlink(intermediateFilePath, fileEventOrigin)
	if styleEntryPoint != nil {
		fs.Unlink(*styleEntryPoint, fileEventOrigin)
	}

	return result
}

type HTMLBuildResult struct {
	Errors      []esbuild.Message
	OutputFiles []esbuild.OutputFile
}

func (p *ProjectBuild) BuildHTML() HTMLBuildResult {
	projectDirectory := path.Join(setup.Directories.Root, p.ProjectID)

	items, _ := fs.ReadDir(projectDirectory, true, true, []string{"node_modules", ".build"})

	result := HTMLBuildResult{
		Errors:      []esbuild.Message{},
		OutputFiles: []esbuild.OutputFile{},
	}

	for _, file := range items {
		if !strings.HasSuffix(file.Name, "index.html") {
			continue
		}

		result.OutputFiles = append(result.OutputFiles, esbuild.OutputFile{
			Path:     file.Name,
			Contents: SetupHTML(path.Join(projectDirectory, file.Name)),
		})
	}

	return result
}

func (p *ProjectBuild) Build() BuildResult {
	result := BuildResult{
		Id:     p.BuildID,
		Errors: []esbuild.Message{},
	}

	tmpBuildDirectory := path.Join(setup.Directories.Tmp, utils.RandString(6))

	exists, _ := fs.Exists(tmpBuildDirectory)
	if exists {
		fs.Rmdir(tmpBuildDirectory, fileEventOrigin)
	}
	fs.Mkdir(tmpBuildDirectory, fileEventOrigin)

	projectDirectory := path.Join(setup.Directories.Root, p.ProjectID)

	entryPointStyle := findEntryPoint(projectDirectory, []string{
		"index.sass",
		"index.scss",
		"index.css",
	})
	entryPointStyleBuiltPtr := (*string)(nil)

	if entryPointStyle != nil {
		styleBuild := p.buildStyle(*entryPointStyle)
		if len(styleBuild.Errors) > 0 {
			result.Errors = append(result.Errors, styleBuild.Errors...)
		} else {
			entryPointStyleBuilt := path.Join(setup.Directories.Tmp, utils.RandString(10)+".css")
			fs.WriteFile(entryPointStyleBuilt, []byte(styleBuild.Css), fileEventOrigin)
			entryPointStyleBuiltPtr = &entryPointStyleBuilt
		}
	}

	entryPointJS := findEntryPoint(projectDirectory, []string{
		"index.js",
		"index.jsx",
		"index.ts",
		"index.tsx",
	})

	if entryPointJS != nil {
		jsBuild := p.buildJS(*entryPointJS, entryPointStyleBuiltPtr)
		if len(jsBuild.Errors) > 0 {
			result.Errors = append(result.Errors, jsBuild.Errors...)
		}
		for _, file := range jsBuild.OutputFiles {
			fs.WriteFile(path.Join(tmpBuildDirectory, file.Path), file.Contents, fileEventOrigin)
		}
	}

	htmlBuild := p.BuildHTML()
	if len(htmlBuild.Errors) > 0 {
		result.Errors = append(result.Errors, htmlBuild.Errors...)
	}
	for _, file := range htmlBuild.OutputFiles {
		filePath := path.Join(tmpBuildDirectory, file.Path)
		fs.Mkdir(path.Dir(filePath), fileEventOrigin)
		fs.WriteFile(filePath, file.Contents, fileEventOrigin)
	}

	outDirectory := path.Join(projectDirectory, ".build")

	if len(result.Errors) == 0 {
		fs.Mkdir(outDirectory, fileEventOrigin)
		fs.Rmdir(outDirectory, fileEventOrigin)
		fs.Rename(tmpBuildDirectory, outDirectory, fileEventOrigin)

		if git.HasGit(outDirectory) {
			head, err := git.Head(outDirectory)
			if err == nil {
				cacheCommitFile := path.Join(outDirectory, ".commit")
				fs.WriteFile(cacheCommitFile, []byte(head.Hash().String()), fileEventOrigin)
			}
		}
	}

	resultJson, _ := json.Marshal(result)
	setup.Callback(p.OriginID, "build", string(resultJson))
	fs.Rmdir(tmpBuildDirectory, fileEventOrigin)

	return result
}
