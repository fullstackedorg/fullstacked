package packages

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"io"
	"net/http"
	"os"
	"path"
	"sort"
	"strings"
	"sync"

	"github.com/Masterminds/semver/v3"
)

type PackagesFn = uint8

const (
	Install   PackagesFn = 0
	Uninstall PackagesFn = 1
	Security  PackagesFn = 2
)

type Progress struct {
	Name     string  `json:"name,omitempty"`
	Version  string  `json:"version,omitempty"`
	Progress float64 `json:"progress,omitempty"`
	Stage    string  `json:"stage"`
}

type ProgressCallback func(Progress)

func Switch(
	ctx *types.CoreCallContext,
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
			Open: func(ctx *types.CoreCallContext, streamId uint8) {
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
			Open: func(ctx *types.CoreCallContext, streamId uint8) {
				uninstall(directory, packagesName, func(p Progress) {
					if ctx != nil {
						store.StreamEvent(ctx, streamId, "progress", []types.SerializableData{p}, p.Stage == "Done")
					}
				})
			},
		}
		return nil

	case Security:
		if len(data) < 1 {
			return errors.New("missing directory argument")
		}
		directory, ok := data[0].Data.(string)
		if !ok {
			return errors.New("directory must be a string")
		}

		report, err := security(directory)
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
	License          string            `json:"license,omitempty"`
	Engines          map[string]string `json:"engines,omitempty"`
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

	onProgress(Progress{Stage: "Initialization", Progress: 0.0})

	// 1. Read package.json
	packageJsonPath := path.Join(directory, "package.json")
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
		for i, nameWithVersion := range packagesName {
			name := nameWithVersion
			rangeStr := "latest"
			lastAt := strings.LastIndex(nameWithVersion, "@")
			if lastAt > 0 {
				name = nameWithVersion[:lastAt]
				rangeStr = nameWithVersion[lastAt+1:]
			}

			onProgress(Progress{
				Name:     name,
				Stage:    "Resolving",
				Progress: 0.1 * (float64(i) / float64(len(packagesName))),
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

	onProgress(Progress{Stage: "Initialization", Progress: 0.1})

	// 2. Load Existing Lockfile (for Pruning/Comparison)
	var oldLock *PackageLock
	packageLockPath := path.Join(directory, "package-lock.json")
	if packageLockContent, err := fs.ReadFileFn(packageLockPath); err == nil {
		oldLock = &PackageLock{}
		if err := json.Unmarshal(packageLockContent, oldLock); err != nil {
			oldLock = nil
		}
	}

	onProgress(Progress{Stage: "Resolving", Progress: 0.15})

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
	}
	queue := []QueueItem{{ParentPath: "", Deps: rootDeps}}

	resolvedCount := 0

	for len(queue) > 0 {
		item := queue[0]
		queue = queue[1:]

		// Sort dependencies for deterministic resolution
		var deps []string
		for name := range item.Deps {
			deps = append(deps, name)
		}
		sort.Strings(deps)

		for _, name := range deps {
			rangeStr := item.Deps[name]
			resolvedCount++
			// Heuristic progress: limit to 0.5 max during resolution
			prog := 0.15 + (0.35 * (1.0 - (1.0 / (1.0 + float64(resolvedCount)*0.1))))

			// We don't have exact version yet, so just Name + Stage
			onProgress(Progress{
				Name:     name,
				Stage:    "Resolving",
				Progress: prog,
			})

			meta, err := fetchPackageMetadata(name)
			if err != nil {
				continue
			}
			ver, err := resolveVersion(meta, rangeStr)
			if err != nil {
				continue
			}

			// Hoisting Logic
			targetPath := ""
			rootSlot := path.Join("node_modules", name)

			if existingVer, ok := installedPaths[rootSlot]; ok {
				if existingVer == ver.Version {
					targetPath = rootSlot // Dedupe
				} else {
					// Conflict at root
					if item.ParentPath == "" {
						targetPath = rootSlot // Overwrite root if we are root
					} else {
						targetPath = path.Join(item.ParentPath, "node_modules", name)
					}
				}
			} else {
				targetPath = rootSlot // Claim root
			}

			// Check if chosen path occupied (if different version)
			if existingVer, ok := installedPaths[targetPath]; ok {
				if existingVer == ver.Version {
					continue // Already processed
				}
				// Conflict/Overwrite behavior: Overwrite.
			}

			integrity := ver.Dist.Integrity
			if integrity == "" {
				integrity = ver.Dist.Shasum
			}

			newLock.Packages[targetPath] = LockDependency{
				Version:          ver.Version,
				Resolved:         ver.Dist.Tarball,
				Integrity:        integrity,
				Dependencies:     ver.Dependencies,
				License:          ver.License,
				Engines:          ver.Engines,
				PeerDependencies: ver.PeerDependencies,
			}
			installedPaths[targetPath] = ver.Version

			combinedDeps := make(map[string]string)
			for k, v := range ver.Dependencies {
				combinedDeps[k] = v
			}
			for k, v := range ver.PeerDependencies {
				combinedDeps[k] = v
			}

			if len(combinedDeps) > 0 {
				queue = append(queue, QueueItem{
					ParentPath: targetPath,
					Deps:       combinedDeps,
				})
			}
		}
	}

	// 5. Install Step
	onProgress(Progress{Stage: "Installing", Progress: 0.6})

	sem := make(chan struct{}, maxConcurrent)
	var wg sync.WaitGroup
	var mu sync.Mutex

	threadSafeProgress := func(p Progress) {
		mu.Lock()
		defer mu.Unlock()
		onProgress(p)
	}

	for k, v := range newLock.Packages {
		if k == "" {
			continue
		}

		targetDir := path.Join(directory, k)

		needsInstall := true
		if fs.ExistsFn(targetDir) {
			if oldLock != nil {
				if oldPkg, ok := oldLock.Packages[k]; ok {
					if oldPkg.Version == v.Version && oldPkg.Integrity == v.Integrity {
						needsInstall = false
					}
				}
			}
		}
		if !needsInstall {
			continue
		}

		pkgName := path.Base(k)
		wg.Add(1)
		go func(ver LockDependency, tDir string, pName string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			fs.RmFn(tDir)
			fs.MkdirFn(tDir)

			downloadAndExtract(ver.Resolved, tDir, pName, func(p float64) {
				threadSafeProgress(Progress{
					Name:     pName,
					Version:  ver.Version,
					Stage:    "Extracting",
					Progress: p,
				})
			})
		}(v, targetDir, pkgName)
	}

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
	onProgress(Progress{Stage: "Finalizing", Progress: 0.95})
	if f, err := fs.CreateFn(packageLockPath); err == nil {
		defer f.Close()
		enc := json.NewEncoder(f)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		enc.Encode(newLock)
	}

	onProgress(Progress{Stage: "Done"})
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

func security(directory string) (map[string]interface{}, error) {
	// 1. Read package-lock.json
	packageLockPath := path.Join(directory, "package-lock.json")
	lockContent, err := fs.ReadFileFn(packageLockPath)
	if err != nil {
		return nil, errors.New("failed to read package-lock.json: " + err.Error())
	}

	// 2. Prepare Payload
	url := registryBaseUrl + "-/npm/v1/security/audits/quick"
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(lockContent))
	if err != nil {
		return nil, errors.New("failed to create request: " + err.Error())
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, errors.New("failed to perform audit: " + err.Error())
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, errors.New("audit failed: " + resp.Status + " " + string(body))
	}

	// 3. Parse Response
	var report map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&report); err != nil {
		return nil, errors.New("failed to parse audit report: " + err.Error())
	}

	return report, nil
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
