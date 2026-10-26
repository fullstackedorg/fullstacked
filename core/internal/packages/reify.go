package packages

// Putting a lockfile's packages on disk the way npm does (@npmcli/arborist):
//
//   - What is on disk is node_modules/.package-lock.json, trusted only while it is the newest
//     thing in node_modules and names exactly the package folders found there
//     (shrinkwrap.js assertNoNewer). Otherwise the folders are read from disk with no version,
//     so every package is extracted again.
//   - A package is kept when its version and integrity (or, without integrity, its resolved
//     URL) match the lockfile (diff.js getAction). Missing ones are added, others replaced,
//     folders the lockfile does not name removed.
//   - The shallowest folders to replace or remove are first moved aside to .<name>-<hash>, the
//     changed packages are extracted into empty folders, the unchanged packages nested in a
//     moved folder are moved back, then the moved folders are deleted. A failure rolls every
//     folder back to how it was (reify.js).
//   - The hidden lockfile is written last, once everything is on disk, so an install that is
//     interrupted (app killed, connection dropped) leaves a folder newer than it and the next
//     install starts over instead of trusting a partial package.

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/internal/git"
	"fullstackedorg/fullstacked/types"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

const hiddenLockfileName = ".package-lock.json"

// Lockfile mtime jitter accepted on folder mtimes (npm: 10 ms), in nanoseconds.
const hiddenLockfileJitter = 10_000_000

// loadActual returns the packages on disk: the hidden lockfile when it can be trusted, else
// the package folders found under node_modules (no version, so none is kept as is).
func loadActual(directory string) map[string]LockDependency {
	if lock := loadHiddenLockfile(directory); lock != nil {
		return lock.Packages
	}
	actual := map[string]LockDependency{}
	walkPackageFolders(directory, "node_modules", func(rel string) error {
		actual[rel] = LockDependency{}
		return nil
	}, nil)
	return actual
}

func loadHiddenLockfile(directory string) *PackageLock {
	p := filepath.Join(directory, "node_modules", hiddenLockfileName)
	stat, err := fs.StatsFn(p)
	if err != nil {
		return nil
	}
	content, err := fs.ReadFileFn(p)
	if err != nil {
		return nil
	}
	lock := &PackageLock{}
	if json.Unmarshal(content, lock) != nil || lock.Packages == nil {
		return nil
	}
	lockTime := stat.MTime + hiddenLockfileJitter
	seen := map[string]bool{}
	err = walkPackageFolders(directory, "node_modules", func(rel string) error {
		seen[rel] = true
		if _, ok := lock.Packages[rel]; !ok {
			return errors.New("missing from lockfile: " + rel)
		}
		return nil
	}, func(rel string, mtime int64) error {
		if mtime > lockTime {
			return errors.New("out of date, updated: " + rel)
		}
		return nil
	})
	if err != nil {
		return nil
	}
	for loc := range lock.Packages {
		if loc != "" && !seen[loc] {
			return nil
		}
	}
	return lock
}

// walkPackageFolders visits the package folders under rel (a node_modules folder), scoped and
// nested ones included, skipping dot entries (.bin, .package-lock.json, retired folders).
// onFolder, when set, sees the mtime of every folder walked, node_modules and scopes included.
func walkPackageFolders(
	directory, rel string,
	onPackage func(rel string) error,
	onFolder func(rel string, mtime int64) error,
) error {
	if onFolder != nil {
		stat, err := fs.StatsFn(filepath.Join(directory, rel))
		if err != nil {
			return err
		}
		if err := onFolder(rel, stat.MTime); err != nil {
			return err
		}
	}
	entries, _ := fs.ReadDirFn(filepath.Join(directory, rel))
	for _, e := range entries {
		if !e.IsDir || strings.HasPrefix(e.Name, ".") {
			continue
		}
		child := path.Join(rel, e.Name)
		var err error
		// a folder named node_modules is a modules folder wherever it is (npm's isNM)
		if strings.HasPrefix(e.Name, "@") || e.Name == "node_modules" {
			err = walkPackageFolders(directory, child, onPackage, onFolder)
		} else {
			err = walkPackage(directory, child, onPackage, onFolder)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func walkPackage(
	directory, rel string,
	onPackage func(rel string) error,
	onFolder func(rel string, mtime int64) error,
) error {
	if onFolder != nil {
		stat, err := fs.StatsFn(filepath.Join(directory, rel))
		if err != nil {
			return err
		}
		if err := onFolder(rel, stat.MTime); err != nil {
			return err
		}
	}
	if err := onPackage(rel); err != nil {
		return err
	}
	nested := path.Join(rel, "node_modules")
	if !fs.ExistsFn(filepath.Join(directory, nested)) {
		return nil
	}
	return walkPackageFolders(directory, nested, onPackage, onFolder)
}

// unchanged is arborist's getAction returning no action for a package present on disk.
func unchanged(ideal, actual LockDependency) bool {
	if ideal.Version != actual.Version {
		return false
	}
	if ideal.Integrity == "" && actual.Integrity == "" {
		return ideal.Resolved == actual.Resolved
	}
	return ideal.Integrity != "" && ideal.Integrity == actual.Integrity
}

// isAncestor reports whether loc is a package nested (at any depth) in the package at parent.
func isAncestor(parent, loc string) bool {
	return strings.HasPrefix(loc, parent+"/node_modules/")
}

var notPathSafe = regexp.MustCompile(`[^a-zA-Z0-9]+`)

// retirePath is where a folder is moved aside: .<name>-<hash> beside it (arborist retire-path.js).
func retirePath(from string) string {
	sum := sha1.Sum([]byte(from))
	hash := notPathSafe.ReplaceAllString(base64.StdEncoding.EncodeToString(sum[:]), "")
	if len(hash) > 8 {
		hash = hash[:8]
	}
	return filepath.Join(filepath.Dir(from), "."+filepath.Base(from)+"-"+hash)
}

type reifyMove struct{ from, to string }

// reify puts the packages of a lockfile on disk; it resolves with the number of packages
// extracted. On error, node_modules is as it was before the call.
func reify(
	ctx *types.Context,
	directory string,
	ideal map[string]LockDependency,
	maxConcurrent int,
	onProgress ProgressCallback,
) (int, error) {
	actual := loadActual(directory)

	wanted := func(loc string, dep LockDependency) bool {
		return loc != "" && isPlatformSupported(dep.OS, dep.CPU)
	}

	// Diff: packages to extract (added or changed) and folders to remove
	var jobs, removes []string
	for loc, dep := range ideal {
		if !wanted(loc, dep) || path.Base(loc) == "fullstacked" {
			continue
		}
		cur, onDisk := actual[loc]
		if !onDisk {
			// A bundled dependency comes with the package that bundles it
			if !dep.InBundle {
				jobs = append(jobs, loc)
			}
		} else if !unchanged(dep, cur) {
			jobs = append(jobs, loc)
		}
	}
	for loc := range actual {
		if loc == "" {
			continue
		}
		if dep, ok := ideal[loc]; !ok || !wanted(loc, dep) {
			removes = append(removes, loc)
		}
	}
	sort.Strings(jobs)
	sort.Strings(removes)

	changed := map[string]bool{}
	for _, loc := range jobs {
		changed[loc] = true
	}
	for _, loc := range removes {
		changed[loc] = true
	}
	hasChangedAncestor := func(loc string) bool {
		for c := range changed {
			if isAncestor(c, loc) {
				return true
			}
		}
		return false
	}

	retired := map[string]string{} // loc -> retired folder
	var shallowJobs []string
	var moves []reifyMove

	rollback := func(cause error) (int, error) {
		for i := len(moves) - 1; i >= 0; i-- {
			fs.RenameFn(moves[i].to, moves[i].from)
		}
		for _, loc := range shallowJobs {
			fs.RmFn(filepath.Join(directory, loc))
		}
		for loc, r := range retired {
			fs.RmFn(filepath.Join(directory, loc))
			fs.RenameFn(r, filepath.Join(directory, loc))
		}
		return 0, cause
	}

	// 1. Move aside the shallowest folders that change or go away
	for _, loc := range append(append([]string{}, jobs...), removes...) {
		if hasChangedAncestor(loc) {
			continue
		}
		if changed[loc] && containsString(jobs, loc) {
			shallowJobs = append(shallowJobs, loc)
		}
		if _, onDisk := actual[loc]; !onDisk {
			continue
		}
		target := filepath.Join(directory, loc)
		r := retirePath(target)
		fs.RmFn(r) // left by an install that was killed
		if err := fs.RenameFn(target, r); err != nil {
			return rollback(err)
		}
		retired[loc] = r
	}

	// 2. Extract the changed packages into empty folders
	sem := make(chan struct{}, maxConcurrent)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var extractErr error
	for _, loc := range jobs {
		dep := ideal[loc]
		wg.Add(1)
		go func(loc string, dep LockDependency) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			displayName := path.Base(loc)
			if strings.HasPrefix(path.Base(path.Dir(loc)), "@") {
				displayName = path.Join(path.Base(path.Dir(loc)), displayName)
			}
			resolved := dep.Resolved
			if resolved == "" {
				resolved = getTarballURL(displayName, dep.Version)
			}
			progress := func(p float64) {
				mu.Lock()
				defer mu.Unlock()
				onProgress(Progress{Name: displayName, Version: dep.Version, Stage: "Extracting", Progress: p})
			}

			target := filepath.Join(directory, loc)
			err := fs.MkdirFn(target)
			if err == nil {
				if gitUrl, isGit := isGithubRepo(resolved); isGit {
					err = git.CloneRepo(ctx, gitUrl, target, nil)
					if err == nil {
						packGitCheckout(target)
					}
				} else {
					err = downloadAndExtract(resolved, target, path.Base(loc), progress)
				}
			}
			progress(1)
			if err != nil {
				mu.Lock()
				if extractErr == nil {
					extractErr = err
				}
				mu.Unlock()
			}
		}(loc, dep)
	}
	wg.Wait()
	if extractErr != nil {
		return rollback(extractErr)
	}

	// 3. Move back the unchanged packages nested in a moved-aside folder (their own files only:
	// their nested packages are moved, extracted or removed on their own)
	var keep []string
	for loc, dep := range ideal {
		if wanted(loc, dep) && !changed[loc] {
			keep = append(keep, loc)
		}
	}
	sort.Strings(keep)
	for _, loc := range keep {
		for parent, r := range retired {
			if !isAncestor(parent, loc) {
				continue
			}
			if ideal[loc].InBundle && hasJobAncestor(jobs, loc) {
				break // came with the package that bundles it
			}
			from := filepath.Join(r, filepath.FromSlash(strings.TrimPrefix(loc, parent+"/")))
			to := filepath.Join(directory, loc)
			if err := fs.MkdirFn(to); err != nil {
				return rollback(err)
			}
			entries, _ := fs.ReadDirFn(from)
			for _, e := range entries {
				if e.Name == "node_modules" {
					continue
				}
				m := reifyMove{from: filepath.Join(from, e.Name), to: filepath.Join(to, e.Name)}
				if err := fs.RenameFn(m.from, m.to); err != nil {
					return rollback(err)
				}
				moves = append(moves, m)
			}
			break
		}
	}

	// 4. Done: drop what was moved aside
	for _, r := range retired {
		fs.RmFn(r)
	}
	return len(jobs), nil
}

func hasJobAncestor(jobs []string, loc string) bool {
	for _, j := range jobs {
		if isAncestor(j, loc) {
			return true
		}
	}
	return false
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// writeHiddenLockfile records the lockfile's packages whose folder is on disk in
// node_modules/.package-lock.json. Written last: its mtime vouches for every folder before it.
func writeHiddenLockfile(directory string, lock *PackageLock) error {
	hidden := *lock
	hidden.Packages = map[string]LockDependency{}
	for loc, dep := range lock.Packages {
		if loc == "" || fs.ExistsFn(filepath.Join(directory, loc)) {
			hidden.Packages[loc] = dep
		}
	}
	if err := fs.MkdirFn(filepath.Join(directory, "node_modules")); err != nil {
		return err
	}
	f, err := fs.CreateFn(filepath.Join(directory, "node_modules", hiddenLockfileName))
	if err != nil {
		return err
	}
	enc := json.NewEncoder(f)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(&hidden); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
