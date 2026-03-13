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
	"net/http"
	"os"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/Masterminds/semver/v3"
)

type PackagesFn = uint8

const (
	Install   PackagesFn = 0
	Uninstall PackagesFn = 1
	Audit     PackagesFn = 2
)

type Progress struct {
	Name     string  `json:"name,omitempty"`
	Version  string  `json:"version,omitempty"`
	Progress float64 `json:"progress,omitempty"`
	Stage    string  `json:"stage"`
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
						store.StreamEvent(ctx, streamId, "progress", []types.SerializableData{p}, p.Stage == "Done")
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
						store.StreamEvent(ctx, streamId, "progress", []types.SerializableData{p}, p.Stage == "Done")
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
	Dependencies         map[string]string `json:"dependencies"`
	OptionalDependencies map[string]string `json:"optionalDependencies,omitempty"`
	// DevDependencies removed as unused in sub-deps logic
	Dist                PackageDist               `json:"dist"`
	License             interface{}               `json:"license,omitempty"`
	Engines             interface{}               `json:"engines,omitempty"`
	PeerDependencies    map[string]string         `json:"peerDependencies,omitempty"`
	BundleDependencies  BundleDependenciesWrapper `json:"bundleDependencies,omitempty"`
	BundledDependencies BundleDependenciesWrapper `json:"bundledDependencies,omitempty"`
	OS                  []string                  `json:"os,omitempty"`
	CPU                 []string                  `json:"cpu,omitempty"`
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
	Version              string            `json:"version,omitempty"`
	Resolved             string            `json:"resolved,omitempty"`
	Integrity            string            `json:"integrity,omitempty"`
	Dependencies         map[string]string `json:"dependencies,omitempty"`
	OptionalDependencies map[string]string `json:"optionalDependencies,omitempty"`
	License              string            `json:"license,omitempty"`
	Engines              map[string]string `json:"engines,omitempty"`
	PeerDependencies     map[string]string `json:"peerDependencies,omitempty"`
	Peer                 bool              `json:"peer,omitempty"`
	Optional             bool              `json:"optional,omitempty"`
	OS                   []string          `json:"os,omitempty"`
	CPU                  []string          `json:"cpu,omitempty"`
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
		json.Unmarshal(packageJsonContent, &pkgJSON)
		json.Unmarshal(packageJsonContent, &rawPkgJSON)
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
					fmt.Println("Metadata Fetch Error:", err)
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
				continue
			}

			versionCaret := rangeStr
			if !isGit {
				// Resolve version based on specifier
				ver, err = resolveVersion(meta, rangeStr)
				if err != nil {
					continue
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
		}
	}

	onProgress(Progress{Stage: "Initialization"})

	// 2. Load Existing Lockfile (for Pruning/Comparison)
	var oldLock *PackageLock
	packageLockPath := path.Join(directory, "package-lock.json")
	if packageLockContent, err := fs.ReadFileFn(packageLockPath); err == nil {
		oldLock = &PackageLock{}
		if err := json.Unmarshal(packageLockContent, oldLock); err != nil {
			oldLock = nil
		}
	}

	// Fast Path: If package-lock exists and no specific packages requested, use lockfile
	if !skipFastPath && len(packagesName) == 0 && oldLock != nil {
		onProgress(Progress{Stage: "Verifying Lockfile"})
		sem := make(chan struct{}, maxConcurrent)
		var wg sync.WaitGroup
		var downloadCount int
		var mu sync.Mutex

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

			if pkg.Resolved == "" {
				continue
			}

			targetDir := path.Join(directory, pathKey)
			if fs.ExistsFn(targetDir) {
				continue
			}

			wg.Add(1)
			go func(pKey string, p LockDependency, tDir string) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()

				pkgName := path.Base(pKey)
				// Handle scoped packages in display name
				displayName := pkgName
				if strings.HasPrefix(path.Base(path.Dir(pKey)), "@") {
					displayName = path.Join(path.Base(path.Dir(pKey)), pkgName)
				}

				fs.MkdirFn(tDir)

				var err error
				gitUrl, isGit := isGithubRepo(p.Resolved)
				if isGit {
					err = git.CloneRepo(ctx, gitUrl, tDir, nil)
					if err == nil {
						fs.RmFn(filepath.Join(tDir, ".git"))
						fs.RmFn(filepath.Join(tDir, ".gitignore"))
						fs.RmFn(filepath.Join(tDir, "package-lock.json"))
					} else {
						fmt.Println("Git CloneRepo Error:", err)
					}
				} else {
					err = downloadAndExtract(p.Resolved, tDir, pkgName, func(prog float64) {
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
				}

				threadSafeProgress(Progress{
					Name:     displayName,
					Version:  p.Version,
					Stage:    "Extracting",
					Progress: 1,
				})
			}(pathKey, pkg, targetDir)
		}

		wg.Wait()

		// Also create node_modules/.package-lock.json in fast path
		fs.MkdirFn(path.Join(directory, "node_modules"))
		nodeModulesLockPath := path.Join(directory, "node_modules", ".package-lock.json")
		if f, err := fs.CreateFn(nodeModulesLockPath); err == nil {
			defer f.Close()
			enc := json.NewEncoder(f)
			enc.SetEscapeHTML(false)
			enc.SetIndent("", "  ")
			enc.Encode(oldLock)
		}

		onProgress(Progress{Stage: "Done", Progress: float64(downloadCount)})
		return
	}

	onProgress(Progress{Stage: "Resolving"})

	name := pkgJSON.Name
	if name == "" {
		name = path.Base(directory)
	}

	// 3. Resolution (BFS / Desired State)
	newLock := &PackageLock{
		Name:            name,
		Version:         pkgJSON.Version,
		Requires:        true,
		LockfileVersion: 3,
		Packages:        make(map[string]LockDependency),
	}
	newLock.Packages[""] = LockDependency{
		Version:      pkgJSON.Version,
		Dependencies: pkgJSON.Dependencies,
	}

	// Prepare Root Deps
	rootDeps := make(map[string]string)
	for k, v := range pkgJSON.Dependencies {
		rootDeps[k] = v
	}
	for k, v := range pkgJSON.DevDependencies {
		rootDeps[k] = v
	}
	for k, v := range pkgJSON.OptionalDependencies {
		rootDeps[k] = v
	}

	installedPaths := make(map[string]string) // path -> version

	// Queue for BFS
	type QueueItem struct {
		ParentPath   string
		Deps         map[string]string
		OptionalDeps map[string]string
		PeerDeps     map[string]string
	}
	queue := []QueueItem{{ParentPath: "", Deps: rootDeps}}

	// Concurrency control for installation
	sem := make(chan struct{}, maxConcurrent)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var downloadCount int

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

		targetDir := path.Join(directory, pathKey)

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
			}
			threadSafeProgress(Progress{
				Name:     pDisplay,
				Version:  ver.Version,
				Stage:    "Extracting",
				Progress: 1,
			})
		}(dep, targetDir, displayName, pkgName)
	}

	resolvedCount := 0
	// Global state lock for resolution maps
	var stateMu sync.Mutex

	for len(queue) > 0 {
		// Snapshot current level for concurrent processing
		currentLevel := queue
		queue = nil // Clear for next level

		var levelWG sync.WaitGroup
		var nextLevelQueue []QueueItem
		var nextQueueMu sync.Mutex

		for _, item := range currentLevel {
			// Merge Deps and unsatisfied PeerDeps
			depsToInstall := make(map[string]string)
			for k, v := range item.Deps {
				depsToInstall[k] = v
			}

			optionalDepsToInstall := make(map[string]string)
			for k, v := range item.OptionalDeps {
				depsToInstall[k] = v
				optionalDepsToInstall[k] = v
			}

			for name, rangeStr := range item.PeerDeps {
				// Check ancestors for satisfied peer dependency
				satisfied := false
				curr := item.ParentPath
				for {
					checkPath := path.Join(curr, "node_modules", name)
					if pkg, ok := newLock.Packages[checkPath]; ok {
						if v, err := semver.NewVersion(pkg.Version); err == nil {
							if c, err := semver.NewConstraint(rangeStr); err == nil {
								if c.Check(v) {
									satisfied = true
									break
								}
							}
						}
					}

					// Move up: find the nearest parent directory that contains "node_modules"
					// We are at `curr`. We want to go to the folder containing the node_modules that contains `curr`.
					// E.g. node_modules/a -> .
					// node_modules/@s/a -> .
					// node_modules/a/node_modules/b -> node_modules/a

					// Check if we are at root
					if curr == "" || curr == "." {
						break
					}

					// Simple approach: look for last "node_modules"
					index := strings.LastIndex(curr, "node_modules")
					if index == -1 {
						break // Should not happen if we are inside node_modules structure
					}

					if index == 0 {
						curr = "" // We are at root node_modules
					} else {
						// node_modules/a/node_modules/b
						// index is 15
						// we want node_modules/a
						// curr[:15] is node_modules/a/
						target := curr[:index]
						// Clean trailing slash if any (though path.Join usually clean)
						target = strings.TrimSuffix(target, string(os.PathSeparator))
						if target == "" {
							target = "."
						}
						curr = target
					}
				}

				if !satisfied {
					depsToInstall[name] = rangeStr
				}
			}

			// Process each dependency in the item concurrently
			for name, rangeStr := range depsToInstall {
				if name == "fullstacked" {
					continue
				}
				levelWG.Add(1)
				isOptional := false
				if _, ok := optionalDepsToInstall[name]; ok {
					isOptional = true
				}

				go func(pName, pRange, parentPath string, pOptional bool) {
					defer levelWG.Done()

					// Acquire semaphore to limit concurrency
					sem <- struct{}{}
					defer func() { <-sem }()

					stateMu.Lock()
					resolvedCount++
					// Progress update
					onProgress(Progress{
						Name:  pName,
						Stage: "Resolving",
					})
					stateMu.Unlock()

					var meta PackageMetadata
					var err error
					var ver PackageVersion

					gitUrl, isGit := isGithubRepo(pRange)
					if isGit {
						meta, err = fetchGithubPackageMetadata(ctx, gitUrl)
						if err == nil {
							ver = meta.Versions[meta.DistTags["latest"]]
						} else {
							fmt.Println("Git Metadata Fetch Error (deps):", err)
						}
					} else {
						meta, err = fetchPackageMetadata(pName)
						if err == nil {
							ver, err = resolveVersion(meta, pRange)
						}
					}

					if err != nil {
						return
					}

					if !isPlatformSupported(ver.OS, ver.CPU) {
						return
					}

					// Critical Section: Hoisting & State Update
					stateMu.Lock()

					// Hoisting Logic
					targetPath := ""
					rootSlot := path.Join("node_modules", pName)

					if existingVer, ok := installedPaths[rootSlot]; ok {
						if existingVer == ver.Version {
							targetPath = rootSlot // Dedupe
						} else {
							// Conflict at root
							if parentPath == "" {
								targetPath = rootSlot // Overwrite root if we are root
							} else {
								targetPath = path.Join(parentPath, "node_modules", pName)
							}
						}
					} else {
						targetPath = rootSlot // Claim root
					}

					// Check if chosen path occupied
					if existingVer, ok := installedPaths[targetPath]; ok {
						if existingVer == ver.Version {
							stateMu.Unlock()
							return // Already processed
						}
					}

					integrity := ver.Dist.Integrity
					if integrity == "" {
						integrity = ver.Dist.Shasum
					}

					depEntry := LockDependency{
						Version:              ver.Version,
						Resolved:             ver.Dist.Tarball,
						Integrity:            integrity,
						Dependencies:         ver.Dependencies,
						OptionalDependencies: ver.OptionalDependencies,
						PeerDependencies:     ver.PeerDependencies,
						Optional:             pOptional,
					}

					if l, ok := ver.License.(string); ok {
						depEntry.License = l
					} else if lMap, ok := ver.License.(map[string]interface{}); ok {
						if t, ok := lMap["type"].(string); ok {
							depEntry.License = t
						}
					}

					if engines, ok := ver.Engines.(map[string]interface{}); ok {
						depEntry.Engines = make(map[string]string)
						for k, v := range engines {
							if s, ok := v.(string); ok {
								depEntry.Engines[k] = s
							}
						}
					} else if engines, ok := ver.Engines.(map[string]string); ok {
						depEntry.Engines = engines
					}
					newLock.Packages[targetPath] = depEntry
					installedPaths[targetPath] = ver.Version

					// Must capture deps before unlocking or just use local var
					deps := make(map[string]string)
					for k, v := range ver.Dependencies {
						isBundled := false
						for _, bd := range ver.BundleDependencies {
							if bd == k {
								isBundled = true
								break
							}
						}
						// also check bundledDependencies fallback
						for _, bd := range ver.BundledDependencies {
							if bd == k {
								isBundled = true
								break
							}
						}
						if !isBundled {
							deps[k] = v
						}
					}
					peerDeps := make(map[string]string)
					for k, v := range ver.PeerDependencies {
						peerDeps[k] = v
					}
					optionalDeps := make(map[string]string)
					for k, v := range ver.OptionalDependencies {
						optionalDeps[k] = v
					}

					// Release state lock before triggering install (which might block/spawn)
					stateMu.Unlock()

					// Trigger installation immediately
					triggerInstall(targetPath, depEntry)

					if len(deps) > 0 || len(peerDeps) > 0 || len(optionalDeps) > 0 {
						nextQueueMu.Lock()
						nextLevelQueue = append(nextLevelQueue, QueueItem{
							ParentPath:   targetPath,
							Deps:         deps,
							OptionalDeps: optionalDeps,
							PeerDeps:     peerDeps,
						})
						nextQueueMu.Unlock()
					}
				}(name, rangeStr, item.ParentPath, isOptional)
			}
		}
		// Wait for this level to complete before moving to next depth
		levelWG.Wait()
		queue = nextLevelQueue
	}

	// Wait for all installations to complete
	wg.Wait()

	// 5.5 Mark peers
	// First, find all packages reachable via regular/optional dependencies from the root
	regularReach := make(map[string]bool)
	queueReq := []string{""}
	regularReach[""] = true

	resolvePath := func(currPath, depName string) string {
		curr := currPath
		for {
			tryPath := path.Join(curr, "node_modules", depName)
			if _, ok := newLock.Packages[tryPath]; ok {
				return tryPath
			}
			if curr == "" || curr == "." {
				break
			}

			dir := path.Dir(curr)
			if path.Base(dir) == "node_modules" {
				curr = path.Dir(dir)
			} else if dir == "node_modules" {
				curr = ""
			} else {
				curr = ""
			}
		}
		return ""
	}

	for len(queueReq) > 0 {
		currPath := queueReq[0]
		queueReq = queueReq[1:]

		pkg := newLock.Packages[currPath]

		deps := make(map[string]string)
		if currPath == "" {
			for k, v := range pkgJSON.Dependencies {
				deps[k] = v
			}
			for k, v := range pkgJSON.DevDependencies {
				deps[k] = v
			}
			for k, v := range pkgJSON.OptionalDependencies {
				deps[k] = v
			}
		} else {
			for k, v := range pkg.Dependencies {
				deps[k] = v
			}
			for k, v := range pkg.OptionalDependencies {
				deps[k] = v
			}
		}

		for depName := range deps {
			resolvedPath := resolvePath(currPath, depName)
			if resolvedPath != "" && !regularReach[resolvedPath] {
				regularReach[resolvedPath] = true
				queueReq = append(queueReq, resolvedPath)
			}
		}
	}

	for pkgPath := range newLock.Packages {
		if pkgPath == "" {
			continue
		}
		if !regularReach[pkgPath] {
			if val, ok := newLock.Packages[pkgPath]; ok {
				val.Peer = true
				newLock.Packages[pkgPath] = val
			}
		}
	}

	// 6. Save Lockfile
	onProgress(Progress{Stage: "Finalizing"})
	if f, err := fs.CreateFn(packageLockPath); err == nil {
		defer f.Close()
		enc := json.NewEncoder(f)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		enc.Encode(newLock)
	}

	// 6.5 Save node_modules/.package-lock.json
	fs.MkdirFn(path.Join(directory, "node_modules"))
	nodeModulesLockPath := path.Join(directory, "node_modules", ".package-lock.json")
	if f, err := fs.CreateFn(nodeModulesLockPath); err == nil {
		defer f.Close()
		enc := json.NewEncoder(f)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if encodeErr := enc.Encode(newLock); encodeErr != nil {
			panic("Encode error: " + encodeErr.Error())
		}
	} else {
		panic("Failed to create node_modules/.package-lock.json: " + err.Error())
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
	packageJsonPath := path.Join(directory, "package.json")
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
		fs.RmFn(path.Join(directory, "node_modules", name))
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
	httpClient      = http.DefaultClient
)

func fetchPackageMetadata(name string) (PackageMetadata, error) {
	req, err := http.NewRequest("GET", registryBaseUrl+name, nil)
	if err != nil {
		return PackageMetadata{}, err
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return PackageMetadata{}, err
	}
	defer resp.Body.Close()

	reader := resp.Body
	if resp.Header.Get("Content-Encoding") == "gzip" {
		gz, err := gzip.NewReader(resp.Body)
		if err != nil {
			return PackageMetadata{}, err
		}
		defer gz.Close()
		reader = gz
	}

	if resp.StatusCode != http.StatusOK {
		return PackageMetadata{}, errors.New("failed to fetch package metadata: " + resp.Status)
	}

	var metadata PackageMetadata
	if err := json.NewDecoder(reader).Decode(&metadata); err != nil {
		return PackageMetadata{}, err
	}

	return metadata, nil
}

func resolveVersion(metadata PackageMetadata, versionRange string) (PackageVersion, error) {
	if versionRange == "" || versionRange == "latest" {
		tag := "latest"
		if v, ok := metadata.DistTags[tag]; ok {
			if version, ok := metadata.Versions[v]; ok {
				return version, nil
			}
		}
		// Fallback to finding max version if latest tag not found (rare)
	}

	c, err := semver.NewConstraint(versionRange)
	if err != nil {
		// if invalid range, maybe it's a specific version or tag
		// try to find exact match
		if v, ok := metadata.Versions[versionRange]; ok {
			return v, nil
		}
		// if still not found, maybe it's a tag like 'next'
		if v, ok := metadata.DistTags[versionRange]; ok {
			if version, ok := metadata.Versions[v]; ok {
				return version, nil
			}
		}
		return PackageVersion{}, err
	}

	var bestVersion PackageVersion
	var bestSemver *semver.Version

	for vStr, version := range metadata.Versions {
		v, err := semver.NewVersion(vStr)
		if err != nil {
			continue
		}

		if c.Check(v) {
			if bestSemver == nil || v.GreaterThan(bestSemver) {
				bestSemver = v
				bestVersion = version
			}
		}
	}

	if bestSemver == nil {
		return PackageVersion{}, errors.New("no matching version found for " + metadata.Name + "@" + versionRange)
	}

	return bestVersion, nil
}

func downloadAndExtract(url string, dest string, packageName string, onProgress func(float64)) error {
	resp, err := httpClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return errors.New("failed to download tarball: " + resp.Status)
	}

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

		targetPath := path.Join(dest, name)

		switch header.Typeflag {
		case tar.TypeDir:
			if err := fs.MkdirFn(targetPath); err != nil {
				return err
			}
		case tar.TypeReg:
			dir := path.Dir(targetPath)
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
