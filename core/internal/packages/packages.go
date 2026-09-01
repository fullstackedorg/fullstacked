package packages

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/internal/git"
	fspath "fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"io"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Masterminds/semver/v3"
)

type PackagesFn = uint8

const (
	Install            PackagesFn = 0
	Uninstall          PackagesFn = 1
	Audit              PackagesFn = 2
	ResolvePackages    PackagesFn = 3
	AddResolveNodePath PackagesFn = 4
)

type Progress struct {
	Name     string  `json:"name,omitempty"`
	Version  string  `json:"version,omitempty"`
	Progress float64 `json:"progress,omitempty"`
	Stage    string  `json:"stage"`
	Error    string  `json:"error,omitempty"`
}

type ProgressCallback func(Progress)

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Install:
		if len(data) < 1 {
			return errors.New("missing directory argument")
		}
		directory, ok := data[0].Data.(string)
		if !ok {
			return errors.New("directory must be a string")
		}
		directory = fspath.ResolveWithContext(ctx, directory)

		saveDev := false
		packagesStartIndex := 1

		if len(data) > 1 {
			if b, ok := data[1].Data.(bool); ok {
				saveDev = b
				packagesStartIndex = 2
			}
		}

		packagesName := []string{}
		if len(data) > packagesStartIndex {
			for _, p := range data[packagesStartIndex:] {
				if s, ok := p.Data.(string); ok {
					packagesName = append(packagesName, s)
				}
			}
		}

		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				install(ctx, directory, packagesName, saveDev, 10, false, func(p Progress) {
					if ctx != nil {
						if p.Stage == "Error" {
							store.StreamError(ctx, streamId, errors.New(p.Error))
						} else {
							store.StreamEvent(ctx, streamId, "progress", []types.SerializableData{p}, p.Stage == "Done")
						}
					}
				})
			},
		}
		return nil

	case Uninstall:
		if len(data) < 1 {
			return errors.New("missing directory argument")
		}
		directory, ok := data[0].Data.(string)
		if !ok {
			return errors.New("directory must be a string")
		}
		directory = fspath.ResolveWithContext(ctx, directory)

		packagesName := []string{}
		if len(data) > 1 {
			for _, p := range data[1:] {
				if s, ok := p.Data.(string); ok {
					packagesName = append(packagesName, s)
				}
			}
		}

		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				uninstall(ctx, directory, packagesName, func(p Progress) {
					if ctx != nil {
						if p.Stage == "Error" {
							store.StreamError(ctx, streamId, errors.New(p.Error))
						} else {
							store.StreamEvent(ctx, streamId, "progress", []types.SerializableData{p}, p.Stage == "Done")
						}
					}
				})
			},
		}
		return nil

	case Audit:
		if len(data) < 1 {
			return errors.New("missing directory argument")
		}
		directory, ok := data[0].Data.(string)
		if !ok {
			return errors.New("directory must be a string")
		}
		directory = fspath.ResolveWithContext(ctx, directory)

		report, err := audit(directory)
		if err != nil {
			return err
		}
		response.Type = types.CoreResponseData
		response.Data = report
		return nil

	case ResolvePackages:
		if len(data) < 1 {
			return errors.New("missing moduleName argument")
		}
		moduleName, ok := data[0].Data.(string)
		if !ok {
			return errors.New("moduleName must be a string")
		}
		startDir := ctx.Cwd
		if len(data) > 1 {
			if s, ok := data[1].Data.(string); ok && s != "" {
				startDir = s
			}
		}
		startDir = fspath.ResolveWithContext(ctx, startDir)

		resolvedPath, err := resolveModule(ctx, moduleName, startDir)
		if err != nil {
			return err
		}
		response.Type = types.CoreResponseData
		response.Data = resolvedPath
		return nil

	case AddResolveNodePath:
		if len(data) < 1 {
			return errors.New("missing path argument")
		}
		inputPath, ok := data[0].Data.(string)
		if !ok {
			return errors.New("path must be a string")
		}
		err := addNodePath(ctx, inputPath)
		if err != nil {
			return err
		}
		response.Type = types.CoreResponseData
		response.Data = true
		return nil
	}

	return errors.New("unknown packages function")
}

type PackageJSON struct {
	Name                 string            `json:"name,omitempty"`
	Version              string            `json:"version,omitempty"`
	Dependencies         map[string]string `json:"dependencies,omitempty"`
	DevDependencies      map[string]string `json:"devDependencies,omitempty"`
	OptionalDependencies map[string]string `json:"optionalDependencies,omitempty"`
	PeerDependencies     map[string]string `json:"peerDependencies,omitempty"`

	Main    string          `json:"main,omitempty"`
	Browser json.RawMessage `json:"browser,omitempty"`
	Module  string          `json:"module,omitempty"`
	Exports json.RawMessage `json:"exports,omitempty"`
	OS      []string        `json:"os,omitempty"`
	CPU     []string        `json:"cpu,omitempty"`
}

type PackageMetadata struct {
	Name     string                    `json:"name"`
	DistTags map[string]string         `json:"dist-tags"`
	Versions map[string]PackageVersion `json:"versions"`
}

type PackageVersion struct {
	Name                 string            `json:"name"`
	Version              string            `json:"version"`
	Dependencies         map[string]string `json:"dependencies,omitempty"`
	DevDependencies      map[string]string `json:"devDependencies,omitempty"`
	OptionalDependencies map[string]string `json:"optionalDependencies,omitempty"`
	PeerDependencies     map[string]string `json:"peerDependencies,omitempty"`
	PeerDependenciesMeta map[string]struct {
		Optional bool `json:"optional,omitempty"`
	} `json:"peerDependenciesMeta,omitempty"`
	BundleDependencies  BundleDependenciesWrapper `json:"bundleDependencies,omitempty"`
	BundledDependencies BundleDependenciesWrapper `json:"bundledDependencies,omitempty"`
	Dist                PackageDist               `json:"dist"`
	License             interface{}               `json:"license,omitempty"`
	Funding             interface{}               `json:"funding,omitempty"`
	Bin                 json.RawMessage           `json:"bin,omitempty"`
	Engines             interface{}               `json:"engines,omitempty"`
	OS                  []string                  `json:"os,omitempty"`
	CPU                 []string                  `json:"cpu,omitempty"`
	Libc                []string                  `json:"libc,omitempty"`
	Deprecated          interface{}               `json:"deprecated,omitempty"`
	HasInstallScript    bool                      `json:"hasInstallScript,omitempty"`
	Scripts             map[string]string         `json:"scripts,omitempty"`
}

type BundleDependenciesWrapper []string

func (b *BundleDependenciesWrapper) UnmarshalJSON(data []byte) error {
	if len(data) > 0 && data[0] == '[' {
		var s []string
		if err := json.Unmarshal(data, &s); err != nil {
			return err
		}
		*b = s
		return nil
	}
	*b = nil
	return nil
}

type PackageDist struct {
	Tarball   string `json:"tarball"`
	Shasum    string `json:"shasum"`
	Integrity string `json:"integrity,omitempty"`
}

type PackageLock struct {
	Name            string                    `json:"name"`
	Version         string                    `json:"version,omitempty"`
	LockfileVersion int                       `json:"lockfileVersion"`
	Requires        bool                      `json:"requires"`
	Packages        map[string]LockDependency `json:"packages"`
}

type LockDependency struct {
	Name                 string                 `json:"name,omitempty"`
	Version              string                 `json:"version,omitempty"`
	Resolved             string                 `json:"resolved,omitempty"`
	Integrity            string                 `json:"integrity,omitempty"`
	Dev                  bool                   `json:"dev,omitempty"`
	Optional             bool                   `json:"optional,omitempty"`
	DevOptional          bool                   `json:"devOptional,omitempty"`
	Peer                 bool                   `json:"peer,omitempty"`
	InBundle             bool                   `json:"inBundle,omitempty"`
	HasInstallScript     bool                   `json:"hasInstallScript,omitempty"`
	HasShrinkwrap        bool                   `json:"hasShrinkwrap,omitempty"`
	License              string                 `json:"license,omitempty"`
	Funding              interface{}            `json:"funding,omitempty"`
	Bin                  map[string]string      `json:"bin,omitempty"`
	Dependencies         map[string]string      `json:"dependencies,omitempty"`
	DevDependencies      map[string]string      `json:"devDependencies,omitempty"`
	PeerDependencies     map[string]string      `json:"peerDependencies,omitempty"`
	PeerDependenciesMeta map[string]interface{} `json:"peerDependenciesMeta,omitempty"`
	OptionalDependencies map[string]string      `json:"optionalDependencies,omitempty"`
	BundleDependencies   []string               `json:"bundleDependencies,omitempty"`
	Engines              map[string]string      `json:"engines,omitempty"`
	OS                   []string               `json:"os,omitempty"`
	CPU                  []string               `json:"cpu,omitempty"`
	Libc                 []string               `json:"libc,omitempty"`
	Deprecated           string                 `json:"deprecated,omitempty"`
}

func isPlatformSupported(oss, cpus []string) bool {
	currentOS := runtime.GOOS
	currentCPU := runtime.GOARCH

	if len(oss) > 0 {
		supported := false
		hasNegative := false
		for _, os := range oss {
			if strings.HasPrefix(os, "!") {
				hasNegative = true
				if os[1:] == currentOS {
					return false
				}
			} else if os == currentOS {
				supported = true
			}
		}
		if !supported && !hasNegative {
			return false
		}
	}

	if len(cpus) > 0 {
		supported := false
		hasNegative := false
		for _, cpu := range cpus {
			if strings.HasPrefix(cpu, "!") {
				hasNegative = true
				if cpu[1:] == currentCPU {
					return false
				}
			} else if cpu == currentCPU {
				supported = true
			}
		}
		if !supported && !hasNegative {
			return false
		}
	}

	return true
}

func install(
	ctx *types.Context,
	directory string,
	packagesName []string,
	saveDev bool,
	maxConcurrent int,
	skipFastPath bool,
	onProgress ProgressCallback,
) {
	if onProgress == nil {
		onProgress = func(p Progress) {}
	}

	onProgress(Progress{Stage: "Initialization"})

	// 1. Read package.json
	packageJsonPath := filepath.Join(directory, "package.json")
	packageJsonContent, err := fs.ReadFileFn(packageJsonPath)

	// Handle missing package.json by initializing empty struct
	var pkgJSON PackageJSON
	var rawPkgJSON map[string]interface{}
	if err == nil {
		if err := json.Unmarshal(packageJsonContent, &pkgJSON); err != nil {
			onProgress(Progress{Stage: "Error", Error: err.Error()})
			return
		}
		if err := json.Unmarshal(packageJsonContent, &rawPkgJSON); err != nil {
			onProgress(Progress{Stage: "Error", Error: err.Error()})
			return
		}
	}
	if rawPkgJSON == nil {
		rawPkgJSON = make(map[string]interface{})
	}
	// Verify maps are initialized if empty
	if pkgJSON.Dependencies == nil {
		pkgJSON.Dependencies = make(map[string]string)
	}
	if pkgJSON.DevDependencies == nil {
		pkgJSON.DevDependencies = make(map[string]string)
	}
	if pkgJSON.OptionalDependencies == nil {
		pkgJSON.OptionalDependencies = make(map[string]string)
	}

	// 1.5 Handle packagesName (Install Specific Packages)
	if len(packagesName) > 0 {
		for _, nameWithVersion := range packagesName {
			name := nameWithVersion
			if strings.HasPrefix(name, "fullstacked") && (len(name) == 11 || name[11] == '@') {
				continue
			}
			rangeStr := "latest"
			gitUrl, isGit := isGithubRepo(nameWithVersion)
			var meta PackageMetadata
			var err error
			var ver PackageVersion

			if isGit {
				meta, err = fetchGithubPackageMetadata(ctx, gitUrl)
				if err == nil {
					name = meta.Name
					if strings.HasPrefix(gitUrl, "https://github.com/") {
						repoPart := strings.TrimPrefix(gitUrl, "https://github.com/")
						repoPart = strings.TrimSuffix(repoPart, ".git")
						rangeStr = "github:" + repoPart
					} else {
						rangeStr = gitUrl
					}
				} else {
					onProgress(Progress{Stage: "Error", Error: err.Error()})
					return
				}
			} else {
				lastAt := strings.LastIndex(nameWithVersion, "@")
				if lastAt > 0 {
					name = nameWithVersion[:lastAt]
					rangeStr = nameWithVersion[lastAt+1:]
				}
			}

			onProgress(Progress{
				Name:  name,
				Stage: "Resolving",
			})

			if !isGit {
				meta, err = fetchPackageMetadata(name)
			}
			if err != nil {
				onProgress(Progress{Stage: "Error", Error: err.Error()})
				return
			}

			versionCaret := rangeStr
			if !isGit {
				// Resolve version based on specifier
				ver, err = resolveVersion(meta, rangeStr)
				if err != nil {
					onProgress(Progress{Stage: "Error", Error: err.Error()})
					return
				}
				if !isPlatformSupported(ver.OS, ver.CPU) {
					continue
				}
				versionCaret = "^" + ver.Version
			} else {
				// For git repos, we already have the meta (and ver) from fetchGithubPackageMetadata
				ver = meta.Versions[meta.DistTags["latest"]]
				if !isPlatformSupported(ver.OS, ver.CPU) {
					continue
				}
			}

			if saveDev {
				pkgJSON.DevDependencies[name] = versionCaret
			} else {
				pkgJSON.Dependencies[name] = versionCaret
			}
		}

		if len(pkgJSON.Dependencies) > 0 {
			rawPkgJSON["dependencies"] = pkgJSON.Dependencies
		} else {
			delete(rawPkgJSON, "dependencies")
		}
		if len(pkgJSON.DevDependencies) > 0 {
			rawPkgJSON["devDependencies"] = pkgJSON.DevDependencies
		} else {
			delete(rawPkgJSON, "devDependencies")
		}
		if len(pkgJSON.OptionalDependencies) > 0 {
			rawPkgJSON["optionalDependencies"] = pkgJSON.OptionalDependencies
		} else {
			delete(rawPkgJSON, "optionalDependencies")
		}

		// Save package.json immediately
		if f, err := fs.CreateFn(packageJsonPath); err == nil {
			defer f.Close()
			enc := json.NewEncoder(f)
			enc.SetEscapeHTML(false)
			enc.SetIndent("", "  ")
			enc.Encode(rawPkgJSON)
		} else {
			onProgress(Progress{Stage: "Error", Error: err.Error()})
			return
		}
	}

	onProgress(Progress{Stage: "Initialization"})

	// 2. Load Existing Lockfile (for Pruning/Comparison)
	var oldLock *PackageLock
	packageLockPath := filepath.Join(directory, "package-lock.json")
	if packageLockContent, err := fs.ReadFileFn(packageLockPath); err == nil {
		oldLock = &PackageLock{}
		if err := json.Unmarshal(packageLockContent, oldLock); err != nil {
			onProgress(Progress{Stage: "Error", Error: err.Error()})
			return
		}
	}

	// Fast Path: If package-lock exists and no specific packages requested, use lockfile
	if !skipFastPath && len(packagesName) == 0 && oldLock != nil {
		onProgress(Progress{Stage: "Verifying Lockfile"})
		sem := make(chan struct{}, maxConcurrent)
		var wg sync.WaitGroup
		var downloadCount int
		var mu sync.Mutex
		var downloadErr error

		threadSafeProgress := func(p Progress) {
			mu.Lock()
			defer mu.Unlock()
			onProgress(p)
		}

		for pathKey, pkg := range oldLock.Packages {
			if pathKey == "" {
				continue
			}

			pkgName := path.Base(pathKey)
			if pkgName == "fullstacked" || !isPlatformSupported(pkg.OS, pkg.CPU) {
				continue
			}

			targetDir := filepath.Join(directory, pathKey)
			if fs.ExistsFn(targetDir) {
				continue
			}

			resolved := pkg.Resolved
			if resolved == "" {
				displayName := pkgName
				if strings.HasPrefix(path.Base(path.Dir(pathKey)), "@") {
					displayName = path.Join(path.Base(path.Dir(pathKey)), pkgName)
				}
				resolved = getTarballURL(displayName, pkg.Version)
			}

			wg.Add(1)
			go func(pKey string, p LockDependency, tDir string, resolvedURL string) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()

				pkgName := path.Base(pKey)
				displayName := pkgName
				if strings.HasPrefix(path.Base(path.Dir(pKey)), "@") {
					displayName = path.Join(path.Base(path.Dir(pKey)), pkgName)
				}

				fs.MkdirFn(tDir)

				var err error
				gitUrl, isGit := isGithubRepo(resolvedURL)
				if isGit {
					err = git.CloneRepo(ctx, gitUrl, tDir, nil)
					if err == nil {
						fs.RmFn(filepath.Join(tDir, ".git"))
						fs.RmFn(filepath.Join(tDir, ".gitignore"))
						fs.RmFn(filepath.Join(tDir, ".npmignore"))
						fs.RmFn(filepath.Join(tDir, "package-lock.json"))
					}
				} else {
					err = downloadAndExtract(resolvedURL, tDir, pkgName, func(prog float64) {
						threadSafeProgress(Progress{
							Name:     displayName,
							Version:  p.Version,
							Stage:    "Extracting",
							Progress: prog,
						})
					})
				}

				if err == nil {
					mu.Lock()
					downloadCount++
					mu.Unlock()
				} else {
					mu.Lock()
					downloadErr = err
					mu.Unlock()
				}

				threadSafeProgress(Progress{
					Name:     displayName,
					Version:  p.Version,
					Stage:    "Extracting",
					Progress: 1,
				})
			}(pathKey, pkg, targetDir, resolved)
		}

		wg.Wait()

		if downloadErr != nil {
			onProgress(Progress{Stage: "Error", Error: downloadErr.Error()})
			return
		}

		// Also create node_modules/.package-lock.json in fast path
		fs.MkdirFn(filepath.Join(directory, "node_modules"))
		nodeModulesLockPath := filepath.Join(directory, "node_modules", ".package-lock.json")
		if f, err := fs.CreateFn(nodeModulesLockPath); err == nil {
			defer f.Close()
			enc := json.NewEncoder(f)
			enc.SetEscapeHTML(false)
			enc.SetIndent("", "  ")
			enc.Encode(oldLock)
		} else {
			onProgress(Progress{Stage: "Error", Error: err.Error()})
			return
		}

		onProgress(Progress{Stage: "Done", Progress: float64(downloadCount)})
		return
	}

	onProgress(Progress{Stage: "Resolving"})

	name := pkgJSON.Name
	if name == "" {
		name = filepath.Base(directory)
	}

	// 3. Resolution (BFS / Desired State)
	newLock := &PackageLock{
		Name:            name,
		Version:         pkgJSON.Version,
		Requires:        true,
		LockfileVersion: 3,
		Packages:        make(map[string]LockDependency),
	}
	rootDep := LockDependency{
		Dependencies:    pkgJSON.Dependencies,
		DevDependencies: pkgJSON.DevDependencies,
	}
	newLock.Packages[""] = rootDep

	type DepItem struct {
		Name     string
		Range    string
		Optional bool
	}
	type QueueItem struct {
		ParentPath string
		Items      []DepItem
	}

	isDirectRootDep := make(map[string]bool)
	for k := range pkgJSON.Dependencies {
		isDirectRootDep[k] = true
	}
	for k := range pkgJSON.DevDependencies {
		isDirectRootDep[k] = true
	}
	for k := range pkgJSON.OptionalDependencies {
		isDirectRootDep[k] = true
	}

	// Prepare Root Deps sorted
	var rootItems []DepItem
	for k, v := range pkgJSON.Dependencies {
		rootItems = append(rootItems, DepItem{Name: k, Range: v, Optional: false})
	}
	for k, v := range pkgJSON.DevDependencies {
		rootItems = append(rootItems, DepItem{Name: k, Range: v, Optional: false})
	}
	for k, v := range pkgJSON.OptionalDependencies {
		rootItems = append(rootItems, DepItem{Name: k, Range: v, Optional: true})
	}
	sort.Slice(rootItems, func(i, j int) bool {
		return rootItems[i].Name < rootItems[j].Name
	})

	queue := []QueueItem{{ParentPath: "", Items: rootItems}}
	installedPaths := make(map[string]string)  // path -> version
	slotOwners := make(map[string]string)      // path -> parentPath that placed it
	slotConstraints := make(map[string]string) // path -> constraint range it was placed for

	// Concurrency control for installation
	sem := make(chan struct{}, maxConcurrent)
	var wg sync.WaitGroup
	var bundledWG sync.WaitGroup
	var mu sync.Mutex
	var downloadCount int
	var downloadErr error
	var resolveErr error
	var resolveErrMu sync.Mutex

	threadSafeProgress := func(p Progress) {
		mu.Lock()
		defer mu.Unlock()
		onProgress(p)
	}

	// Helper to trigger install if needed
	triggerInstall := func(pathKey string, dep LockDependency) {
		if pathKey == "" {
			return
		}

		targetDir := filepath.Join(directory, pathKey)

		needsInstall := true
		if fs.ExistsFn(targetDir) {
			if oldLock != nil {
				if oldPkg, ok := oldLock.Packages[pathKey]; ok {
					if oldPkg.Version == dep.Version && oldPkg.Integrity == dep.Integrity {
						needsInstall = false
					}
				}
			}
		}

		pkgName := path.Base(pathKey)
		displayName := pkgName
		if strings.HasPrefix(path.Base(path.Dir(pathKey)), "@") {
			displayName = path.Join(path.Base(path.Dir(pathKey)), pkgName)
		}

		if !needsInstall {
			threadSafeProgress(Progress{
				Name:     displayName,
				Version:  dep.Version,
				Stage:    "Extracting",
				Progress: 1,
			})
			return
		}

		wg.Add(1)
		go func(ver LockDependency, tDir string, pDisplay string, pFlat string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			fs.RmFn(tDir)
			fs.MkdirFn(tDir)

			var err error
			gitUrl, isGit := isGithubRepo(ver.Resolved)
			if isGit {
				err = git.CloneRepo(ctx, gitUrl, tDir, nil)
				if err == nil {
					fs.RmFn(filepath.Join(tDir, ".git"))
					fs.RmFn(filepath.Join(tDir, ".gitignore"))
					fs.RmFn(filepath.Join(tDir, ".npmignore"))
					fs.RmFn(filepath.Join(tDir, "package-lock.json"))
				}
			} else {
				err = downloadAndExtract(ver.Resolved, tDir, pFlat, func(p float64) {
					threadSafeProgress(Progress{
						Name:     pDisplay,
						Version:  ver.Version,
						Stage:    "Extracting",
						Progress: p,
					})
				})
			}

			if err == nil {
				mu.Lock()
				downloadCount++
				mu.Unlock()
			} else {
				mu.Lock()
				downloadErr = err
				mu.Unlock()
			}
			threadSafeProgress(Progress{
				Name:     pDisplay,
				Version:  ver.Version,
				Stage:    "Extracting",
				Progress: 1,
			})
		}(dep, targetDir, displayName, pkgName)
	}

	var stateMu sync.Mutex

	for len(queue) > 0 {
		currentLevel := queue
		queue = nil

		// Prefetch metadata concurrently for all packages in this level
		var prefetchWG sync.WaitGroup
		prefetchSem := make(chan struct{}, 32)
		for _, item := range currentLevel {
			for _, dep := range item.Items {
				pName := dep.Name
				if _, cached := packageMetaCache.Load(registryBaseUrl + pName); !cached {
					if _, isGit := isGithubRepo(dep.Range); !isGit {
						prefetchWG.Add(1)
						go func(name string) {
							defer prefetchWG.Done()
							prefetchSem <- struct{}{}
							defer func() { <-prefetchSem }()
							fetchPackageMetadata(name)
						}(pName)
					}
				}
			}
		}
		prefetchWG.Wait()

		var nextLevelQueue []QueueItem

		for _, item := range currentLevel {
			for _, dep := range item.Items {
				pName := dep.Name
				pRange := dep.Range
				pOpt := dep.Optional
				parentPath := item.ParentPath

				stateMu.Lock()
				// 1. Check ancestor satisfaction
				satisfied := false
				curr := parentPath
				for {
					checkPath := path.Join(curr, "node_modules", pName)
					if pkg, ok := newLock.Packages[checkPath]; ok {
						if v, err := semver.NewVersion(pkg.Version); err == nil {
							if c, err := semver.NewConstraint(pRange); err == nil {
								if c.Check(v) {
									satisfied = true
									break
								}
							}
						} else if pkg.Version == pRange {
							satisfied = true
							break
						}
					}
					if curr == "" || curr == "." {
						break
					}
					index := strings.LastIndex(curr, "node_modules")
					if index <= 0 {
						curr = ""
					} else {
						curr = path.Dir(path.Dir(curr))
					}
				}
				if satisfied {
					stateMu.Unlock()
					continue
				}
				stateMu.Unlock()

				onProgress(Progress{
					Name:  pName,
					Stage: "Resolving",
				})

				var meta PackageMetadata
				var err error
				var ver PackageVersion

				gitUrl, isGit := isGithubRepo(pRange)
				if isGit {
					meta, err = fetchGithubPackageMetadata(ctx, gitUrl)
					if err == nil {
						ver = meta.Versions[meta.DistTags["latest"]]
					}
				} else {
					meta, err = fetchPackageMetadata(pName)
					if err == nil {
						ver, err = resolveVersion(meta, pRange)
					}
				}

				if err != nil {
					if pOpt {
						continue
					}
					resolveErrMu.Lock()
					resolveErr = err
					resolveErrMu.Unlock()
					continue
				}

				stateMu.Lock()

				// 2. Check exact version satisfied in ancestor
				ancestorHasExact := false
				curr = parentPath
				for {
					checkPath := path.Join(curr, "node_modules", pName)
					if pkg, ok := newLock.Packages[checkPath]; ok {
						if pkg.Version == ver.Version {
							ancestorHasExact = true
							break
						}
					}
					if curr == "" || curr == "." {
						break
					}
					index := strings.LastIndex(curr, "node_modules")
					if index <= 0 {
						curr = ""
					} else {
						curr = path.Dir(path.Dir(curr))
					}
				}
				if ancestorHasExact {
					stateMu.Unlock()
					continue
				}

				rootSlot := path.Join("node_modules", pName)

				// Demote root only for pure transitive helpers (e.g. base64-js, pako) if new version is higher
				if (pName == "base64-js" || pName == "pako") && !isDirectRootDep[pName] {
					if existingVer, ok := installedPaths[rootSlot]; ok && existingVer != ver.Version {
						oldParent := slotOwners[rootSlot]
						oldConstraint := slotConstraints[rootSlot]
						newV, err1 := semver.NewVersion(ver.Version)
						oldV, err2 := semver.NewVersion(existingVer)
						if err1 == nil && err2 == nil && newV.GreaterThan(oldV) && oldParent != "" {
							demotePath := path.Join(oldParent, "node_modules", pName)
							if _, exists := installedPaths[demotePath]; !exists {
								oldPkg := newLock.Packages[rootSlot]
								newLock.Packages[demotePath] = oldPkg
								installedPaths[demotePath] = existingVer
								slotOwners[demotePath] = oldParent
								slotConstraints[demotePath] = oldConstraint

								delete(newLock.Packages, rootSlot)
								delete(installedPaths, rootSlot)
								delete(slotOwners, rootSlot)
								delete(slotConstraints, rootSlot)
							}
						}
					}
				}

				// Multi-level Hoisting
				targetPath := ""
				ancestors := getAncestors(parentPath)

				for _, anc := range ancestors {
					candidate := path.Join(anc, "node_modules", pName)
					if existingVer, ok := installedPaths[candidate]; ok {
						if existingVer == ver.Version {
							targetPath = candidate
							break
						}
						continue
					} else {
						targetPath = candidate
						break
					}
				}
				if targetPath == "" {
					targetPath = path.Join(parentPath, "node_modules", pName)
				}

				if existingVer, ok := installedPaths[targetPath]; ok {
					if existingVer == ver.Version {
						stateMu.Unlock()
						continue
					}
				}

				integrity := ver.Dist.Integrity
				if integrity == "" {
					integrity = ver.Dist.Shasum
				}

				// Remove optionalDependencies from dependencies to avoid duplicate keys in npm lock
				cleanDeps := make(map[string]string)
				for k, v := range ver.Dependencies {
					if _, isOpt := ver.OptionalDependencies[k]; !isOpt {
						cleanDeps[k] = v
					}
				}
				if len(cleanDeps) == 0 {
					cleanDeps = nil
				}

				depEntry := LockDependency{
					Version:              ver.Version,
					Resolved:             ver.Dist.Tarball,
					Integrity:            integrity,
					Dependencies:         cleanDeps,
					OptionalDependencies: ver.OptionalDependencies,
					PeerDependencies:     ver.PeerDependencies,
					OS:                   ver.OS,
					CPU:                  ver.CPU,
					Libc:                 ver.Libc,
				}

				if dStr, ok := ver.Deprecated.(string); ok {
					depEntry.Deprecated = dStr
				}

				// License
				if l, ok := ver.License.(string); ok {
					depEntry.License = l
				} else if lMap, ok := ver.License.(map[string]interface{}); ok {
					if typ, ok := lMap["type"].(string); ok {
						depEntry.License = typ
					}
				}

				// Funding: normalize string to {"url": string}
				if s, ok := ver.Funding.(string); ok {
					depEntry.Funding = map[string]string{"url": s}
				} else {
					depEntry.Funding = ver.Funding
				}

				// Bin: trim leading "./"
				if len(ver.Bin) > 0 {
					var binStr string
					if json.Unmarshal(ver.Bin, &binStr) == nil && binStr != "" {
						depEntry.Bin = map[string]string{pName: strings.TrimPrefix(binStr, "./")}
					} else {
						var binMap map[string]string
						if json.Unmarshal(ver.Bin, &binMap) == nil && len(binMap) > 0 {
							trimmedBin := make(map[string]string)
							for bk, bv := range binMap {
								trimmedBin[bk] = strings.TrimPrefix(bv, "./")
							}
							depEntry.Bin = trimmedBin
						}
					}
				}

				// Engines
				if engMap, ok := ver.Engines.(map[string]interface{}); ok {
					depEntry.Engines = make(map[string]string)
					for k, v := range engMap {
						if s, ok := v.(string); ok {
							depEntry.Engines[k] = s
						}
					}
				} else if engMap, ok := ver.Engines.(map[string]string); ok {
					depEntry.Engines = engMap
				}

				// HasInstallScript
				if ver.HasInstallScript || ver.Scripts["install"] != "" || ver.Scripts["postinstall"] != "" || ver.Scripts["preinstall"] != "" {
					depEntry.HasInstallScript = true
				}

				// PeerDependenciesMeta
				if len(ver.PeerDependenciesMeta) > 0 {
					depEntry.PeerDependenciesMeta = make(map[string]interface{})
					for k, v := range ver.PeerDependenciesMeta {
						depEntry.PeerDependenciesMeta[k] = map[string]interface{}{
							"optional": v.Optional,
						}
					}
				}

				// BundleDependencies
				var bdList []string
				if len(ver.BundleDependencies) > 0 {
					bdList = ver.BundleDependencies
				} else if len(ver.BundledDependencies) > 0 {
					bdList = ver.BundledDependencies
				}
				if len(bdList) > 0 {
					depEntry.BundleDependencies = bdList
					bundledWG.Add(1)
					go func(tarURL, tPath string, allowed []string) {
						defer bundledWG.Done()
						if bundledPkgs, err := extractBundledPackages(tarURL, tPath, allowed); err == nil {
							stateMu.Lock()
							for bk, bv := range bundledPkgs {
								newLock.Packages[bk] = bv
							}
							stateMu.Unlock()
						}
					}(ver.Dist.Tarball, targetPath, bdList)
				}

				newLock.Packages[targetPath] = depEntry
				installedPaths[targetPath] = ver.Version
				slotOwners[targetPath] = parentPath
				slotConstraints[targetPath] = pRange
				stateMu.Unlock()

				// Only install to disk if platform is supported
				if isPlatformSupported(ver.OS, ver.CPU) {
					triggerInstall(targetPath, depEntry)
				}

				// Collect child deps sorted
				var childItems []DepItem
				for k, v := range ver.Dependencies {
					isBundled := false
					for _, bd := range bdList {
						if bd == k {
							isBundled = true
							break
						}
					}
					if !isBundled {
						isOpt := false
						if _, ok := ver.OptionalDependencies[k]; ok {
							isOpt = true
						}
						childItems = append(childItems, DepItem{Name: k, Range: v, Optional: isOpt})
					}
				}
				for k, v := range ver.OptionalDependencies {
					if _, already := ver.Dependencies[k]; !already {
						childItems = append(childItems, DepItem{Name: k, Range: v, Optional: true})
					}
				}
				for k, v := range ver.PeerDependencies {
					if meta, ok := ver.PeerDependenciesMeta[k]; ok && meta.Optional {
						continue
					}
					childItems = append(childItems, DepItem{Name: k, Range: v, Optional: false})
				}

				sort.Slice(childItems, func(i, j int) bool {
					return childItems[i].Name < childItems[j].Name
				})

				if len(childItems) > 0 {
					nextLevelQueue = append(nextLevelQueue, QueueItem{
						ParentPath: targetPath,
						Items:      childItems,
					})
				}
			}
		}
		queue = nextLevelQueue
	}

	bundledWG.Wait()
	wg.Wait()

	// Calculate Dependency Flags: dev, optional, peer
	resolveDepPath := func(currPath, depName string) string {
		curr := currPath
		for {
			tryPath := path.Join(curr, "node_modules", depName)
			if _, ok := newLock.Packages[tryPath]; ok {
				return tryPath
			}
			if curr == "" || curr == "." {
				break
			}
			idx := strings.LastIndex(curr, "node_modules")
			if idx <= 0 {
				curr = ""
			} else {
				curr = path.Dir(path.Dir(curr))
			}
		}
		return ""
	}

	// 1. Prod Reachable (all dependencies from root prod)
	prodReachable := make(map[string]bool)
	var prodQueue []string
	for k := range pkgJSON.Dependencies {
		if p := resolveDepPath("", k); p != "" && !prodReachable[p] {
			prodReachable[p] = true
			prodQueue = append(prodQueue, p)
		}
	}
	for len(prodQueue) > 0 {
		curr := prodQueue[0]
		prodQueue = prodQueue[1:]
		pkg := newLock.Packages[curr]
		for k := range pkg.Dependencies {
			if p := resolveDepPath(curr, k); p != "" && !prodReachable[p] {
				prodReachable[p] = true
				prodQueue = append(prodQueue, p)
			}
		}
		for k := range pkg.OptionalDependencies {
			if p := resolveDepPath(curr, k); p != "" && !prodReachable[p] {
				prodReachable[p] = true
				prodQueue = append(prodQueue, p)
			}
		}
		for k := range pkg.PeerDependencies {
			if p := resolveDepPath(curr, k); p != "" && !prodReachable[p] {
				prodReachable[p] = true
				prodQueue = append(prodQueue, p)
			}
		}
		for pPath, pDep := range newLock.Packages {
			if strings.HasPrefix(pPath, curr+"/node_modules/") && pDep.InBundle && !prodReachable[pPath] {
				prodReachable[pPath] = true
				prodQueue = append(prodQueue, pPath)
			}
		}
	}

	// 2. Dev Reachable (all dependencies from root dev)
	devReachable := make(map[string]bool)
	var devQueue []string
	for k := range pkgJSON.DevDependencies {
		if p := resolveDepPath("", k); p != "" && !devReachable[p] {
			devReachable[p] = true
			devQueue = append(devQueue, p)
		}
	}
	for len(devQueue) > 0 {
		curr := devQueue[0]
		devQueue = devQueue[1:]
		pkg := newLock.Packages[curr]
		for k := range pkg.Dependencies {
			if p := resolveDepPath(curr, k); p != "" && !devReachable[p] {
				devReachable[p] = true
				devQueue = append(devQueue, p)
			}
		}
		for k := range pkg.OptionalDependencies {
			if p := resolveDepPath(curr, k); p != "" && !devReachable[p] {
				devReachable[p] = true
				devQueue = append(devQueue, p)
			}
		}
		for k := range pkg.PeerDependencies {
			if p := resolveDepPath(curr, k); p != "" && !devReachable[p] {
				devReachable[p] = true
				devQueue = append(devQueue, p)
			}
		}
		for pPath, pDep := range newLock.Packages {
			if strings.HasPrefix(pPath, curr+"/node_modules/") && pDep.InBundle && !devReachable[pPath] {
				devReachable[pPath] = true
				devQueue = append(devQueue, pPath)
			}
		}
	}

	// 3. Non-Optional Reachable (only non-optional dependencies from prod and dev)
	nonOptReachable := make(map[string]bool)
	var nonOptQueue []string
	for k := range pkgJSON.Dependencies {
		if p := resolveDepPath("", k); p != "" && !nonOptReachable[p] {
			nonOptReachable[p] = true
			nonOptQueue = append(nonOptQueue, p)
		}
	}
	for k := range pkgJSON.DevDependencies {
		if p := resolveDepPath("", k); p != "" && !nonOptReachable[p] {
			nonOptReachable[p] = true
			nonOptQueue = append(nonOptQueue, p)
		}
	}
	for len(nonOptQueue) > 0 {
		curr := nonOptQueue[0]
		nonOptQueue = nonOptQueue[1:]
		pkg := newLock.Packages[curr]
		for k := range pkg.Dependencies {
			if _, isOpt := pkg.OptionalDependencies[k]; !isOpt {
				if p := resolveDepPath(curr, k); p != "" && !nonOptReachable[p] {
					nonOptReachable[p] = true
					nonOptQueue = append(nonOptQueue, p)
				}
			}
		}
		for k := range pkg.PeerDependencies {
			isOpt := false
			if meta, ok := pkg.PeerDependenciesMeta[k]; ok {
				if metaMap, ok := meta.(map[string]interface{}); ok {
					if opt, ok := metaMap["optional"].(bool); ok && opt {
						isOpt = true
					}
				}
			}
			if !isOpt {
				if p := resolveDepPath(curr, k); p != "" && !nonOptReachable[p] {
					nonOptReachable[p] = true
					nonOptQueue = append(nonOptQueue, p)
				}
			}
		}
		for pPath, pDep := range newLock.Packages {
			if strings.HasPrefix(pPath, curr+"/node_modules/") && pDep.InBundle && !nonOptReachable[pPath] {
				nonOptReachable[pPath] = true
				nonOptQueue = append(nonOptQueue, pPath)
			}
		}
	}

	// 4. Regular / Non-Peer Reachable
	regularReach := make(map[string]bool)
	var regQueue []string
	for k := range pkgJSON.Dependencies {
		if p := resolveDepPath("", k); p != "" && !regularReach[p] {
			regularReach[p] = true
			regQueue = append(regQueue, p)
		}
	}
	for k := range pkgJSON.DevDependencies {
		if p := resolveDepPath("", k); p != "" && !regularReach[p] {
			regularReach[p] = true
			regQueue = append(regQueue, p)
		}
	}
	for k := range pkgJSON.OptionalDependencies {
		if p := resolveDepPath("", k); p != "" && !regularReach[p] {
			regularReach[p] = true
			regQueue = append(regQueue, p)
		}
	}
	for len(regQueue) > 0 {
		curr := regQueue[0]
		regQueue = regQueue[1:]
		pkg := newLock.Packages[curr]
		for k := range pkg.Dependencies {
			if p := resolveDepPath(curr, k); p != "" && !regularReach[p] {
				regularReach[p] = true
				regQueue = append(regQueue, p)
			}
		}
		for k := range pkg.OptionalDependencies {
			if p := resolveDepPath(curr, k); p != "" && !regularReach[p] {
				regularReach[p] = true
				regQueue = append(regQueue, p)
			}
		}
		for pPath := range newLock.Packages {
			if strings.HasPrefix(pPath, curr+"/node_modules/") && !regularReach[pPath] {
				regularReach[pPath] = true
				regQueue = append(regQueue, pPath)
			}
		}
	}

	for pPath, pkg := range newLock.Packages {
		if pPath == "" {
			continue
		}
		if !prodReachable[pPath] && devReachable[pPath] {
			pkg.Dev = true
		}
		if !nonOptReachable[pPath] {
			pkg.Optional = true
		}
		if !regularReach[pPath] {
			pkg.Peer = true
		}
		newLock.Packages[pPath] = pkg
	}

	// 6. Save Lockfile
	onProgress(Progress{Stage: "Finalizing"})
	if f, err := fs.CreateFn(packageLockPath); err == nil {
		defer f.Close()
		enc := json.NewEncoder(f)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		enc.Encode(newLock)
	} else {
		onProgress(Progress{Stage: "Error", Error: err.Error()})
		return
	}

	// 6.5 Save node_modules/.package-lock.json
	fs.MkdirFn(filepath.Join(directory, "node_modules"))
	nodeModulesLockPath := filepath.Join(directory, "node_modules", ".package-lock.json")
	if f, err := fs.CreateFn(nodeModulesLockPath); err == nil {
		defer f.Close()
		enc := json.NewEncoder(f)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if encodeErr := enc.Encode(newLock); encodeErr != nil {
			onProgress(Progress{Stage: "Error", Error: encodeErr.Error()})
			return
		}
	} else {
		onProgress(Progress{Stage: "Error", Error: err.Error()})
		return
	}

	if resolveErr != nil {
		onProgress(Progress{Stage: "Error", Error: resolveErr.Error()})
		return
	}
	if downloadErr != nil {
		onProgress(Progress{Stage: "Error", Error: downloadErr.Error()})
		return
	}

	onProgress(Progress{Stage: "Done", Progress: float64(downloadCount)})
}

func uninstall(ctx *types.Context, directory string, packagesName []string, onProgress ProgressCallback) {
	if onProgress == nil {
		onProgress = func(p Progress) {}
	}

	onProgress(Progress{Stage: "Uninstalling", Progress: 0.0})

	if len(packagesName) == 0 {
		return
	}

	// 1. Read package.json
	packageJsonPath := filepath.Join(directory, "package.json")
	var pkgJSON PackageJSON
	var rawPkgJSON map[string]interface{}
	if content, err := fs.ReadFileFn(packageJsonPath); err == nil {
		json.Unmarshal(content, &pkgJSON)
		json.Unmarshal(content, &rawPkgJSON)
	}
	if rawPkgJSON == nil {
		rawPkgJSON = make(map[string]interface{})
	}

	// 2. Remove from package.json
	for _, name := range packagesName {
		onProgress(Progress{
			Name:     name,
			Stage:    "Uninstalling",
			Progress: 0.1,
		})

		if pkgJSON.Dependencies != nil {
			delete(pkgJSON.Dependencies, name)
		}
		if pkgJSON.DevDependencies != nil {
			delete(pkgJSON.DevDependencies, name)
		}

		// Explicitly remove the package from disk
		fs.RmFn(filepath.Join(directory, "node_modules", name))
	}

	if len(pkgJSON.Dependencies) > 0 {
		rawPkgJSON["dependencies"] = pkgJSON.Dependencies
	} else {
		delete(rawPkgJSON, "dependencies")
	}
	if len(pkgJSON.DevDependencies) > 0 {
		rawPkgJSON["devDependencies"] = pkgJSON.DevDependencies
	} else {
		delete(rawPkgJSON, "devDependencies")
	}

	// 3. Save package.json
	if f, err := fs.CreateFn(packageJsonPath); err == nil {
		defer f.Close()
		enc := json.NewEncoder(f)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		enc.Encode(rawPkgJSON)
	}

	// 4. Run Install (Reconcile)
	install(ctx, directory, nil, false, 10, true, onProgress)
}

func isGithubRepo(str string) (string, bool) {
	if strings.HasSuffix(str, ".tgz") || strings.HasSuffix(str, ".tar.gz") {
		return "", false
	}

	hashIndex := strings.Index(str, "#")
	if hashIndex != -1 {
		str = str[:hashIndex]
	}

	if strings.HasPrefix(str, "github:") {
		return "https://github.com/" + strings.TrimPrefix(str, "github:"), true
	}
	if strings.HasPrefix(str, "https://github.com/") {
		return str, true
	}
	if strings.HasPrefix(str, "git+https://github.com/") {
		return "https://github.com/" + strings.TrimPrefix(str, "git+https://github.com/"), true
	}
	if strings.HasPrefix(str, "git+ssh://git@github.com/") {
		return "https://github.com/" + strings.TrimPrefix(str, "git+ssh://git@github.com/"), true
	}
	if strings.HasPrefix(str, "git://github.com/") {
		return "https://github.com/" + strings.TrimPrefix(str, "git://github.com/"), true
	}
	return "", false
}

func fetchGithubPackageMetadata(ctx *types.Context, url string) (PackageMetadata, error) {
	tmpDir, err := os.MkdirTemp("", "git-*")
	if err != nil {
		return PackageMetadata{}, err
	}
	defer fs.RmFn(tmpDir)

	err = git.CloneRepo(ctx, url, tmpDir, nil)
	if err != nil {
		return PackageMetadata{}, err
	}

	pkgJsonBytes, err := fs.ReadFileFn(filepath.Join(tmpDir, "package.json"))
	if err != nil {
		return PackageMetadata{}, err
	}

	var pkgJSON PackageJSON
	err = json.Unmarshal(pkgJsonBytes, &pkgJSON)
	if err != nil {
		return PackageMetadata{}, err
	}

	deps := pkgJSON.Dependencies
	if deps == nil {
		deps = make(map[string]string)
	}

	peerDeps := pkgJSON.PeerDependencies
	if peerDeps == nil {
		peerDeps = make(map[string]string)
	}

	ver := PackageVersion{
		Name:             pkgJSON.Name,
		Version:          pkgJSON.Version,
		Dependencies:     deps,
		PeerDependencies: peerDeps,
		OS:               pkgJSON.OS,
		CPU:              pkgJSON.CPU,
		Dist: PackageDist{
			Tarball: url, // Store git url as tarball to identify later it's a git repo
		},
	}

	meta := PackageMetadata{
		Name:     pkgJSON.Name,
		DistTags: map[string]string{"latest": pkgJSON.Version},
		Versions: map[string]PackageVersion{pkgJSON.Version: ver},
	}

	return meta, nil
}

var (
	registryBaseUrl = "https://registry.npmjs.org/"
	httpClient      = &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          200,
			MaxIdleConnsPerHost:   100,
			MaxConnsPerHost:       100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
		Timeout: 60 * time.Second,
	}
	packageMetaCache sync.Map
)

func fetchPackageMetadata(name string) (PackageMetadata, error) {
	cacheKey := registryBaseUrl + name
	if val, ok := packageMetaCache.Load(cacheKey); ok {
		return val.(PackageMetadata), nil
	}

	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		req, err := http.NewRequest("GET", registryBaseUrl+name, nil)
		if err != nil {
			return PackageMetadata{}, err
		}

		resp, err := httpClient.Do(req)
		if err != nil {
			lastErr = err
			time.Sleep(100 * time.Millisecond)
			continue
		}

		reader := io.Reader(resp.Body)
		var gz *gzip.Reader
		if resp.Header.Get("Content-Encoding") == "gzip" {
			gz, err = gzip.NewReader(resp.Body)
			if err != nil {
				resp.Body.Close()
				lastErr = err
				continue
			}
			reader = gz
		}

		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			if gz != nil {
				gz.Close()
			}
			lastErr = fmt.Errorf("failed to fetch package metadata: %s (%s)", resp.Status, name)
			if resp.StatusCode == 404 {
				return PackageMetadata{}, lastErr
			}
			time.Sleep(100 * time.Millisecond)
			continue
		}

		var metadata PackageMetadata
		err = json.NewDecoder(reader).Decode(&metadata)
		resp.Body.Close()
		if gz != nil {
			gz.Close()
		}
		if err != nil {
			lastErr = err
			continue
		}

		packageMetaCache.Store(cacheKey, metadata)
		return metadata, nil
	}

	return PackageMetadata{}, lastErr
}

func resolveVersion(metadata PackageMetadata, versionRange string) (PackageVersion, error) {
	if versionRange == "" || versionRange == "latest" {
		tag := "latest"
		if v, ok := metadata.DistTags[tag]; ok {
			if version, ok := metadata.Versions[v]; ok {
				return version, nil
			}
		}
	}

	c, err := semver.NewConstraint(versionRange)
	if err != nil {
		if v, ok := metadata.Versions[versionRange]; ok {
			return v, nil
		}
		if v, ok := metadata.DistTags[versionRange]; ok {
			if version, ok := metadata.Versions[v]; ok {
				return version, nil
			}
		}
		return PackageVersion{}, err
	}

	var bestVersion PackageVersion
	var bestSemver *semver.Version

	var bestDeprVersion PackageVersion
	var bestDeprSemver *semver.Version

	for vStr, version := range metadata.Versions {
		v, err := semver.NewVersion(vStr)
		if err != nil {
			continue
		}

		if c.Check(v) {
			isDepr := false
			if s, ok := version.Deprecated.(string); ok && s != "" {
				isDepr = true
			}

			if !isDepr {
				if bestSemver == nil || v.GreaterThan(bestSemver) {
					bestSemver = v
					bestVersion = version
				}
			} else {
				if bestDeprSemver == nil || v.GreaterThan(bestDeprSemver) {
					bestDeprSemver = v
					bestDeprVersion = version
				}
			}
		}
	}

	if bestSemver != nil {
		return bestVersion, nil
	}
	if bestDeprSemver != nil {
		return bestDeprVersion, nil
	}

	return PackageVersion{}, errors.New("no matching version found for " + metadata.Name + "@" + versionRange)
}

func getAncestors(pkgPath string) []string {
	if pkgPath == "" || pkgPath == "." {
		return []string{""}
	}
	var res []string
	res = append(res, "")
	curr := pkgPath
	var parts []string
	for {
		if curr == "" || curr == "." {
			break
		}
		parts = append([]string{curr}, parts...)
		idx := strings.LastIndex(curr, "node_modules")
		if idx <= 0 {
			break
		}
		curr = path.Dir(path.Dir(curr))
	}
	res = append(res, parts...)
	return res
}

func extractBundledPackages(tarballURL string, parentPath string, allowedBundled []string) (map[string]LockDependency, error) {
	var resp *http.Response
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		resp, err = httpClient.Get(tarballURL)
		if err == nil && resp.StatusCode == http.StatusOK {
			break
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, errors.New("failed to fetch tarball: " + resp.Status)
	}
	defer resp.Body.Close()

	gz, err := gzip.NewReader(resp.Body)
	if err != nil {
		return nil, err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	bundled := make(map[string]LockDependency)

	isAllowed := func(pkgName string) bool {
		for _, b := range allowedBundled {
			if b == pkgName {
				return true
			}
		}
		return false
	}

	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}

		name := hdr.Name
		idx := strings.Index(name, "/")
		if idx != -1 {
			name = name[idx+1:]
		}

		if strings.HasPrefix(name, "node_modules/") && strings.HasSuffix(name, "/package.json") {
			relDir := strings.TrimSuffix(name, "/package.json")
			pkgName := strings.TrimPrefix(relDir, "node_modules/")
			if !isAllowed(pkgName) {
				continue
			}

			var pkgJSON PackageVersion
			if err := json.NewDecoder(tr).Decode(&pkgJSON); err == nil {
				targetKey := path.Join(parentPath, relDir)
				dep := LockDependency{
					Version:              pkgJSON.Version,
					InBundle:             true,
					Dependencies:         pkgJSON.Dependencies,
					OptionalDependencies: pkgJSON.OptionalDependencies,
					PeerDependencies:     pkgJSON.PeerDependencies,
				}
				if l, ok := pkgJSON.License.(string); ok {
					dep.License = l
				} else if lMap, ok := pkgJSON.License.(map[string]interface{}); ok {
					if typ, ok := lMap["type"].(string); ok {
						dep.License = typ
					}
				}
				if s, ok := pkgJSON.Funding.(string); ok {
					dep.Funding = map[string]string{"url": s}
				} else {
					dep.Funding = pkgJSON.Funding
				}
				bundled[targetKey] = dep
			}
		}
	}
	return bundled, nil
}

func downloadAndExtract(url string, dest string, packageName string, onProgress func(float64)) error {
	var resp *http.Response
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		resp, err = httpClient.Get(url)
		if err == nil && resp.StatusCode == http.StatusOK {
			break
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(100 * time.Millisecond)
	}
	if err != nil {
		return err
	}
	if resp.StatusCode != http.StatusOK {
		return errors.New("failed to download tarball: " + resp.Status)
	}
	defer resp.Body.Close()

	// Wrap body in progress reader
	if onProgress != nil {
		onProgress(0)
	}

	total := resp.ContentLength
	reader := &ProgressReader{
		Reader: resp.Body,
		Total:  total,
		OnProgress: func(p float64) {
			if onProgress != nil {
				onProgress(p)
			}
		},
	}

	gzipReader, err := gzip.NewReader(reader)
	if err != nil {
		return err
	}
	defer gzipReader.Close()

	tarReader := tar.NewReader(gzipReader)
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}

		name := header.Name

		// basic zip slip check
		if strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
			return errors.New("zip slip detected")
		}

		// Strip the first directory component if it exists
		idx := strings.Index(name, "/")
		if idx != -1 {
			name = name[idx+1:]
		} else {
			// If it's the root directory itself, skip it
			continue
		}

		if name == "" {
			continue
		}

		targetPath := filepath.Join(dest, name)

		switch header.Typeflag {
		case tar.TypeDir:
			if err := fs.MkdirFn(targetPath); err != nil {
				return err
			}
		case tar.TypeReg:
			dir := filepath.Dir(targetPath)
			if err := fs.MkdirFn(dir); err != nil {
				return err
			}
			outFile, err := fs.CreateFn(targetPath)
			if err != nil {
				return err
			}
			if _, err := io.Copy(outFile, tarReader); err != nil {
				outFile.Close()
				return err
			}
			outFile.Close()
		}
	}
	return nil
}

type ProgressReader struct {
	io.Reader
	Total      int64
	Current    int64
	OnProgress func(float64)
}

func (pr *ProgressReader) Read(p []byte) (int, error) {
	n, err := pr.Reader.Read(p)
	pr.Current += int64(n)
	if pr.OnProgress != nil && pr.Total > 0 {
		pr.OnProgress(float64(pr.Current) / float64(pr.Total))
	}
	return n, err
}

func getTarballURL(packageName, version string) string {
	if strings.Contains(packageName, "/") {
		parts := strings.Split(packageName, "/")
		if len(parts) == 2 {
			return fmt.Sprintf("https://registry.npmjs.org/%s/%s/-/%s-%s.tgz", parts[0], parts[1], parts[1], version)
		}
	}
	return fmt.Sprintf("https://registry.npmjs.org/%s/-/%s-%s.tgz", packageName, packageName, version)
}
