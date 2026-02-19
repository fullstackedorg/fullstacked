package packages

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/fs"
	fspath "fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
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
				install(directory, packagesName, saveDev, 10, func(p Progress) {
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
				uninstall(directory, packagesName, func(p Progress) {
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
	Name            string            `json:"name,omitempty"`
	Version         string            `json:"version,omitempty"`
	Dependencies    map[string]string `json:"dependencies,omitempty"`
	DevDependencies map[string]string `json:"devDependencies,omitempty"`

	Main    string          `json:"main,omitempty"`
	Browser json.RawMessage `json:"browser,omitempty"`
	Module  string          `json:"module,omitempty"`
	Exports json.RawMessage `json:"exports,omitempty"`
}

type PackageMetadata struct {
	Name     string                    `json:"name"`
	DistTags map[string]string         `json:"dist-tags"`
	Versions map[string]PackageVersion `json:"versions"`
}

type PackageVersion struct {
	Name         string            `json:"name"`
	Version      string            `json:"version"`
	Dependencies map[string]string `json:"dependencies"`
	// DevDependencies removed as unused in sub-deps logic
	Dist             PackageDist       `json:"dist"`
	License          interface{}       `json:"license,omitempty"`
	Engines          interface{}       `json:"engines,omitempty"`
	PeerDependencies map[string]string `json:"peerDependencies,omitempty"`
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
	Version          string            `json:"version,omitempty"`
	Resolved         string            `json:"resolved,omitempty"`
	Integrity        string            `json:"integrity,omitempty"`
	Dependencies     map[string]string `json:"dependencies,omitempty"`
	License          string            `json:"license,omitempty"`
	Engines          map[string]string `json:"engines,omitempty"`
	PeerDependencies map[string]string `json:"peerDependencies,omitempty"`
	Peer             bool              `json:"peer,omitempty"`
}

func install(
	directory string,
	packagesName []string,
	saveDev bool,
	maxConcurrent int,
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
	if err == nil {
		json.Unmarshal(packageJsonContent, &pkgJSON)
	}
	// Verify maps are initialized if empty
	if pkgJSON.Dependencies == nil {
		pkgJSON.Dependencies = make(map[string]string)
	}
	if pkgJSON.DevDependencies == nil {
		pkgJSON.DevDependencies = make(map[string]string)
	}

	// 1.5 Handle packagesName (Install Specific Packages)
	if len(packagesName) > 0 {
		for _, nameWithVersion := range packagesName {
			name := nameWithVersion
			rangeStr := "latest"
			lastAt := strings.LastIndex(nameWithVersion, "@")
			if lastAt > 0 {
				name = nameWithVersion[:lastAt]
				rangeStr = nameWithVersion[lastAt+1:]
			}

			onProgress(Progress{
				Name:  name,
				Stage: "Resolving",
			})

			meta, err := fetchPackageMetadata(name)
			if err != nil {
				continue
			}

			// Resolve version based on specifier
			ver, err := resolveVersion(meta, rangeStr)
			if err != nil {
				continue
			}

			versionCaret := "^" + ver.Version
			if saveDev {
				pkgJSON.DevDependencies[name] = versionCaret
			} else {
				pkgJSON.Dependencies[name] = versionCaret
			}
		}

		// Save package.json immediately
		if f, err := fs.CreateFn(packageJsonPath); err == nil {
			defer f.Close()
			enc := json.NewEncoder(f)
			enc.SetEscapeHTML(false)
			enc.SetIndent("", "  ")
			enc.Encode(pkgJSON)
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

	installedPaths := make(map[string]string) // path -> version

	// Queue for BFS
	type QueueItem struct {
		ParentPath string
		Deps       map[string]string
		PeerDeps   map[string]string
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

			err := downloadAndExtract(ver.Resolved, tDir, pFlat, func(p float64) {
				threadSafeProgress(Progress{
					Name:     pDisplay,
					Version:  ver.Version,
					Stage:    "Extracting",
					Progress: p,
				})
			})

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
				levelWG.Add(1)
				go func(pName, pRange, parentPath string) {
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

					meta, err := fetchPackageMetadata(pName)
					if err != nil {
						return
					}
					ver, err := resolveVersion(meta, pRange)
					if err != nil {
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
						Version:          ver.Version,
						Resolved:         ver.Dist.Tarball,
						Integrity:        integrity,
						Dependencies:     ver.Dependencies,
						PeerDependencies: ver.PeerDependencies,
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
						deps[k] = v
					}
					peerDeps := make(map[string]string)
					for k, v := range ver.PeerDependencies {
						peerDeps[k] = v
					}

					// Release state lock before triggering install (which might block/spawn)
					stateMu.Unlock()

					// Trigger installation immediately
					triggerInstall(targetPath, depEntry)

					if len(deps) > 0 || len(peerDeps) > 0 {
						nextQueueMu.Lock()
						nextLevelQueue = append(nextLevelQueue, QueueItem{
							ParentPath: targetPath,
							Deps:       deps,
							PeerDeps:   peerDeps,
						})
						nextQueueMu.Unlock()
					}
				}(name, rangeStr, item.ParentPath)
			}
		}
		// Wait for this level to complete before moving to next depth
		levelWG.Wait()
		queue = nextLevelQueue
	}

	// Wait for all installations to complete
	wg.Wait()

	// 5.5 Mark peers
	peersToMark := make(map[string]bool)
	for pkgPath, pkg := range newLock.Packages {
		for peerName := range pkg.PeerDependencies {
			curr := pkgPath
			// Simple node resolution up the tree
			for {
				tryPath := path.Join(curr, "node_modules", peerName)
				if _, ok := newLock.Packages[tryPath]; ok {
					peersToMark[tryPath] = true
					break
				}
				if curr == "" || curr == "." {
					break
				}

				// Move up: strip node_modules/PKG
				dir := path.Dir(curr)
				if path.Base(dir) == "node_modules" {
					curr = path.Dir(dir)
				} else if dir == "node_modules" {
					curr = ""
				} else {
					curr = ""
				}
			}
		}
	}

	for p := range peersToMark {
		if val, ok := newLock.Packages[p]; ok {
			val.Peer = true
			newLock.Packages[p] = val
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

	onProgress(Progress{Stage: "Done", Progress: float64(downloadCount)})
}

func uninstall(directory string, packagesName []string, onProgress ProgressCallback) {
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
	if content, err := fs.ReadFileFn(packageJsonPath); err == nil {
		json.Unmarshal(content, &pkgJSON)
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

	// 3. Save package.json
	if f, err := fs.CreateFn(packageJsonPath); err == nil {
		defer f.Close()
		enc := json.NewEncoder(f)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		enc.Encode(pkgJSON)
	}

	// 4. Run Install (Reconcile)
	install(directory, nil, false, 10, onProgress)
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

		// npm tarballs usually have a root 'package' folder
		// we strip it
		name := header.Name
		if len(name) > 8 && name[0:8] == "package/" {
			name = name[8:]
		} else if name == "package" {
			continue
		} else if packageName != "" {
			prefix := packageName + "/"
			if strings.HasPrefix(name, prefix) {
				name = strings.TrimPrefix(name, prefix)
			} else if name == packageName {
				continue
			}
		}

		if name == "" {
			continue
		}

		targetPath := path.Join(dest, name)

		// basic zip slip check
		if !strings.HasPrefix(targetPath, path.Clean(dest)+string(os.PathSeparator)) && targetPath != dest {
			return errors.New("zip slip detected")
		}

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
