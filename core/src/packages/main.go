package packages

import (
	"encoding/json"
	"fmt"
	fs "fullstackedorg/fullstacked/src/fs"
	"fullstackedorg/fullstacked/src/git"
	setup "fullstackedorg/fullstacked/src/setup"
	"net/http"
	"net/url"
	"path"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	semver "github.com/Masterminds/semver/v3"
)

var fileEventOrigin = "packages"

type Installation struct {
	Id                     float64           `json:"id"`
	PackagesInstalledCount float64           `json:"packagesInstalledCount"`
	Duration               float64           `json:"duration"`
	ProjectId              string            `json:"-"`
	Packages               []*Package        `json:"-"`
	LocalPackages          []PackageLockJSON `json:"-"`
	BaseDirectory          string            `json:"-"`
	Quick                  bool              `json:"-"`
}

func (i *Installation) notify() {
	jsonData, err := json.Marshal(i)
	if err != nil {
		fmt.Println(err)
		return
	}

	jsonStr := string(jsonData)

	setup.Callback(i.ProjectId, "packages-installation", jsonStr)
}

/*	   name       version
* |      ⌄       |   ⌄   |
* @scoped/package@version
*
*   name  version
* |  ⌄   |   ⌄   |
* package@version
 */
func ParsePackageName(name string) (string, string) {
	scoped := strings.HasPrefix(name, "@")
	version := ""

	if scoped {
		parts := strings.Split(name, "@")
		if len(parts) > 2 {
			name = "@" + parts[1]
			version = parts[2]
		}
	} else {
		parts := strings.Split(name, "@")
		if len(parts) > 1 {
			name = parts[0]
			version = parts[1]
		}
	}

	return name, version
}

type npmPackageInfoVersion struct {
	Dist struct {
		Tarball string `json:"tarball"`
	} `json:"dist"`
	Dependencies map[string]string `json:"dependencies"`
}

type npmPackageInfo struct {
	Tags     map[string]string                `json:"dist-tags"`
	Versions map[string]npmPackageInfoVersion `json:"versions"`
}

func findAvailableVersion(name string, versionRequested string) *semver.Version {
	// get available versions and tag on npmjs
	npmVersions, err := http.Get("https://registry.npmjs.org/" + name)
	if err != nil {
		fmt.Println(err)
		return nil
	}
	defer npmVersions.Body.Close()

	npmVersionsJSON := &npmPackageInfo{}
	err = json.NewDecoder(npmVersions.Body).Decode(npmVersionsJSON)
	if err != nil {
		fmt.Println(err)
		return nil
	}

	// check in tags if versioon where looking for is there
	// ie package@beta
	if npmVersionsJSON.Tags[versionRequested] != "" {
		versionRequested = npmVersionsJSON.Tags[versionRequested]
	}

	constraints, _ := semver.NewConstraint(versionRequested)
	availableVersions := []*semver.Version{}
	for v := range npmVersionsJSON.Versions {
		version, err := semver.NewVersion(v)
		if err == nil {
			availableVersions = append(availableVersions, version)
		}
	}

	vc := semver.Collection(availableVersions)
	sort.Sort(sort.Reverse(vc))

	if constraints != nil {
		for _, v := range availableVersions {
			if constraints.Check(v) {
				return v
			}
		}
	}

	// if no constraint works, use latest
	if len(availableVersions) > 0 {
		return availableVersions[0]
	}

	return nil
}

func (i *Installation) NewPackage(packageName string) Package {
	name, versionStr := ParsePackageName(packageName)
	p := i.NewPackageWithVersionStr(name, versionStr)
	p.As = []string{}
	return p
}

func (i *Installation) NewPackageWithVersionStr(name string, versionStr string) Package {
	if versionStr == "" {
		versionStr = "latest"
	}

	for _, p := range i.LocalPackages {
		if p.Name == name && slices.Contains(p.As, versionStr) {
			v, _ := semver.NewVersion(p.Version)
			return i.NewPackageFromLock(name, v, []string{versionStr}, p.Git)
		}
	}

	if strings.Contains(versionStr, "/") {
		return i.NewPackageFromGit(name, "", pseudoGitUrlToUrl(versionStr), "")
	}

	version := findAvailableVersion(name, versionStr)
	return i.NewPackageFromLock(name, version, []string{versionStr}, "")
}

func pseudoGitUrlToUrl(pseudoUrl string) *url.URL {
	urlComponents := strings.Split(pseudoUrl, ":")
	repo := urlComponents[len(urlComponents)-1]

	if strings.Contains(repo, "#") {
		repoComponents := strings.Split(repo, "#")
		repo = repoComponents[0]
	}

	host := strings.Join(urlComponents[:len(urlComponents)-1], ":")

	scheme := "https"
	if strings.HasPrefix(urlComponents[0], "git+") {
		scheme = urlComponents[0]
		host = strings.Join(urlComponents[1:len(urlComponents)-1], ":")
	}

	scheme = strings.TrimPrefix(scheme, "git+")
	host = strings.TrimLeft(host, "/")

	URL, err := url.Parse(scheme + "://" + host + "/" + repo + ".git")

	if err != nil {
		fmt.Println(err)
		return nil
	}

	return URL
}

func urlToPseudoGitUrl(url *url.URL) string {
	repo := strings.TrimSuffix(url.Path, ".git")
	repo = strings.TrimPrefix(repo, "/")
	ref := url.Fragment

	pseudoUrl := url.Host + ":" + repo
	if url.Scheme != "https" {
		pseudoUrl = url.Scheme + ":" + pseudoUrl
	}

	if ref != "" {
		pseudoUrl += "#" + ref
	}

	return pseudoUrl
}

// gitUrl: [SCHEME:]hostname[:PORT]:repo/name[#HASH|TAG|BRANCH]
func (i *Installation) NewPackageFromGit(
	name string,
	versionStr string,
	url *url.URL,
	refType git.RefType,
) Package {
	pseudoUrl := urlToPseudoGitUrl(url)

	pseudoUrlNoFragment := pseudoUrl
	ref := ""

	if strings.Contains(pseudoUrl, "#") {
		pseudoUrlComponents := strings.Split(pseudoUrl, "#")
		ref = pseudoUrlComponents[len(pseudoUrlComponents)-1]
		pseudoUrlNoFragment = strings.Join(pseudoUrlComponents[:len(pseudoUrlComponents)-1], "#")
	}

	for _, lp := range i.LocalPackages {
		if strings.HasPrefix(lp.As[0], pseudoUrlNoFragment) {
			lpRef := ""

			if strings.Contains(lp.As[0], "#") {
				lpRefComps := strings.Split(lp.As[0], "#")
				lpRef = lpRefComps[len(lpRefComps)-1]
			}

			directory := i.BaseDirectory + "/" + lp.Locations[0] + "/" + lp.Name
			lpRefType := lp.Git

			if git.IsOnRef(directory, ref, lpRefType) {
				v, _ := semver.NewVersion(lp.Version)
				p := i.NewPackageFromLock(lp.Name, v, []string{pseudoUrl}, refType)
				if ref != lpRef {
					p.GitRefType = git.CheckoutRef(directory, ref, "")
					p.updateNameAndVersionWithPackageJSON(directory)
				} else {
					p.GitRefType = lp.Git
				}
				return p
			}
		}
	}

	p := i.NewPackageFromLock(name, nil, []string{pseudoUrl}, refType)

	if versionStr == "" {
		p.cloneAndCheckoutGitPackageToTmp()
	} else {
		v, err := semver.NewVersion(versionStr)
		p.Version = v

		if err != nil {
			fmt.Println("bad version string from git package")
		}
	}

	return p
}

func (i *Installation) NewPackageFromLock(
	name string,
	version *semver.Version,
	as []string,
	gitRefType git.RefType,
) Package {
	return Package{
		Name:       name,
		Version:    version,
		As:         as,
		GitRefType: gitRefType,
	}
}

func (installation *Installation) getPackageDependencies(
	p *Package,
	wg *sync.WaitGroup,
	mutex *sync.Mutex,
) {
	defer wg.Done()

	deps := p.getDependencies(installation)

	newPackages := []*Package{}
	for _, dep := range deps {
		seen := false

		mutex.Lock()
		for _, pp := range installation.Packages {
			if pp.Name == dep.Name && pp.Version.Equal(dep.Version) {
				seen = true
				pp.As = mergeSlices(pp.As, dep.As)
				pp.Dependants = append(pp.Dependants, p)
				break
			}
		}
		mutex.Unlock()

		if !seen {
			newPackages = append(newPackages, &dep)
			mutex.Lock()
			installation.Packages = append(installation.Packages, &dep)
			mutex.Unlock()
		}
	}

	if len(newPackages) > 0 {
		installation.getDependencies(newPackages, wg, mutex)
	}
}

func (installation *Installation) getDependencies(
	packages []*Package,
	wg *sync.WaitGroup,
	mutex *sync.Mutex,
) {
	for _, p := range packages {
		wg.Add(1)
		go installation.getPackageDependencies(p, wg, mutex)
	}
}

func (installation *Installation) untanglePackages() {
	// sort by version descending
	// this will assure we have most recent version in root install
	/*
	*   - foo v3.0.0
	*	- bar v1.2.3
	*		- foo v2.0.0
	*	- baz v3.2.1
	*		- foo v1.0.0
	 */

	sort.Slice(installation.Packages, func(i, j int) bool {
		return installation.Packages[i].Version.GreaterThan(installation.Packages[j].Version)
	})

	toInstall := []*Package{}
	for _, p := range installation.Packages {

		alreadyAdded := false
		for _, pp := range toInstall {
			if p.Name == pp.Name {
				alreadyAdded = true
				break
			}
		}

		if alreadyAdded {

			// place it in dependants dependencies
			for _, pp := range p.Dependants {
				pp.Dependencies = append(pp.Dependencies, p)
			}

		} else {
			toInstall = append(toInstall, p)
		}
	}

	installation.Packages = toInstall
}

func Install(installationId float64, directory string, devDependencies bool, packagesName []string) {
	start := time.Now().UnixMilli()

	installation := Installation{
		ProjectId:              "",
		Id:                     installationId,
		BaseDirectory:          directory,
		PackagesInstalledCount: 0,
	}

	installation.loadLocalPackages()
	directPackages := installation.loadDirectPackages()

	wg := sync.WaitGroup{}
	mutex := sync.Mutex{}

	newDirectPackages := []Package{}
	gitPackages := []string{}
	for _, pName := range packagesName {
		if strings.HasPrefix(pName, "http://") || strings.HasPrefix(pName, "https://") {
			// add to list of git packages
			gitPackages = append(gitPackages, pName)
		} else {
			newDirectPackages = append(newDirectPackages, installation.NewPackage(pName))
		}
	}

	// clone all git packages url
	// valid repos must be append to newDirectPackages
	for _, gitPackageUrl := range gitPackages {
		gitUrl, err := url.Parse(gitPackageUrl)
		if err != nil {
			fmt.Println(err)
			continue
		}

		wg.Add(1)
		go func() {
			defer wg.Done()
			p := installation.NewPackageFromGit("", "", gitUrl, "")
			newDirectPackages = append(newDirectPackages, p)
		}()
	}

	wg.Wait()

	for _, p := range newDirectPackages {
		p.Direct = true
		p.Dev = devDependencies

		// replace existing direct package with same name
		for i, pp := range directPackages {
			if pp.Name == p.Name {
				directPackages[i] = directPackages[len(directPackages)-1]
				directPackages = directPackages[:len(directPackages)-1]
				break
			}
		}

		if p.Version != nil {
			directPackages = append(directPackages, &p)
		}
	}

	installation.Packages = directPackages
	installation.getDependencies(directPackages, &wg, &mutex)

	wg.Wait()

	installation.untanglePackages()

	for _, p := range installation.Packages {
		p.InstallationId = installation.Id
		wg.Add(1)
		go p.Install(&installation, "node_modules", &wg, &mutex)
	}

	wg.Wait()

	installation.updatePackageAndLock()

	installation.Duration = float64(time.Now().UnixMilli() - start)
	installation.notify()
}

func InstallQuick(projectId string, installationId float64, directory string) {
	start := time.Now().UnixMilli()

	installation := Installation{
		ProjectId:              projectId,
		Id:                     installationId,
		BaseDirectory:          directory,
		PackagesInstalledCount: 0,
		Quick:                  true,
	}

	lockFile := path.Join(installation.BaseDirectory, "lock.json")
	exists, isFile := fs.Exists(lockFile)

	if !exists || !isFile {
		installation.Duration = float64(time.Now().UnixMilli() - start)
		installation.notify()
		return
	}

	installation.loadLocalPackages()

	// shortest path first to avoid cleaning a directory where a sub-dependency was installed
	sort.Slice(installation.LocalPackages, func(i, j int) bool {
		return installation.LocalPackages[i].Locations[0] < installation.LocalPackages[j].Locations[0]
	})

	wg := sync.WaitGroup{}
	mutex := sync.Mutex{}
	maxGoroutines := 20

	guard := make(chan struct{}, maxGoroutines)
	for _, pInfo := range installation.LocalPackages {
		guard <- struct{}{}
		wg.Add(1)
		go func(p PackageLockJSON) {
			installPackageFromLock(&installation, p, &wg, &mutex)
			<-guard
		}(pInfo)
	}

	wg.Wait()

	installation.Duration = float64(time.Now().UnixMilli() - start)
	installation.notify()
}

func installPackageFromLock(installation *Installation, pInfo PackageLockJSON, parentWg *sync.WaitGroup, mutex *sync.Mutex) {
	v, _ := semver.NewVersion(pInfo.Version)
	p := installation.NewPackageFromLock(pInfo.Name, v, pInfo.As, pInfo.Git)

	slices.SortFunc(pInfo.Locations, func(a, b string) int {
		if a < b {
			return -1
		}
		return 1
	})

	wg := sync.WaitGroup{}

	for _, l := range pInfo.Locations {
		wg.Add(1)
		go p.Install(installation, l, &wg, mutex)
	}

	wg.Wait()
	parentWg.Done()
}

type DirectPackageJSON struct {
	Dependencies    map[string]string `json:"dependencies"`
	DevDependencies map[string]string `json:"devDependencies"`
	raw             map[string]json.RawMessage
}

type PackageLock struct {
	Packages []PackageLockJSON `json:"packages"`
}

func (installation *Installation) updatePackageAndLock() {
	direct := DirectPackageJSON{
		Dependencies:    map[string]string{},
		DevDependencies: map[string]string{},
		raw:             map[string]json.RawMessage{},
	}

	packageJsonFilePath := path.Join(installation.BaseDirectory, "package.json")

	exists, isFile := fs.Exists(packageJsonFilePath)
	if exists && isFile {
		packageJsonData, _ := fs.ReadFile(packageJsonFilePath)
		json.Unmarshal(packageJsonData, &direct.raw)
	}

	for _, p := range installation.Packages {
		if !p.Direct {
			continue
		}

		if p.Dev {
			if direct.DevDependencies == nil {
				direct.DevDependencies = map[string]string{}
			}

			v := "^" + p.Version.String()
			p.As = appendIfContainsNot(p.As, v)
			if p.VersionOriginal != "" {
				v = p.VersionOriginal
				p.As = appendIfContainsNot(p.As, v)
			}
			direct.DevDependencies[p.Name] = v
		} else {
			if direct.Dependencies == nil {
				direct.Dependencies = map[string]string{}
			}

			v := "^" + p.Version.String()
			if p.GitRefType != "" {
				v = p.As[0]
			}

			p.As = appendIfContainsNot(p.As, v)
			if p.VersionOriginal != "" {
				v = p.VersionOriginal
				p.As = appendIfContainsNot(p.As, v)
			}

			direct.Dependencies[p.Name] = v
		}
	}

	if len(direct.Dependencies) > 0 {
		dependencies, _ := json.MarshalIndent(direct.Dependencies, "", "    ")
		direct.raw["dependencies"] = json.RawMessage(dependencies)
	}
	if len(direct.DevDependencies) > 0 {
		devDependencies, _ := json.MarshalIndent(direct.DevDependencies, "", "    ")
		direct.raw["devDependencies"] = json.RawMessage(devDependencies)
	}

	jsonData, err := json.MarshalIndent(direct.raw, "", "    ")
	if err != nil {
		fmt.Println(err)
	}
	fs.WriteFile(packageJsonFilePath, jsonData, fileEventOrigin)

	lock := &PackageLock{
		Packages: []PackageLockJSON{},
	}
	lock.addPackagesToLock(installation.Packages)

	sort.Slice(lock.Packages, func(i, j int) bool {
		if lock.Packages[i].Name == lock.Packages[j].Name {
			return lock.Packages[i].Version < lock.Packages[j].Version
		}
		return lock.Packages[i].Name < lock.Packages[j].Name
	})

	jsonData, err = json.MarshalIndent(lock, "", "    ")
	if err != nil {
		fmt.Println(err)
	}
	fs.WriteFile(path.Join(installation.BaseDirectory, "lock.json"), jsonData, fileEventOrigin)
}

func (lock *PackageLock) addPackagesToLock(packages []*Package) {
	for _, p := range packages {
		for _, pp := range lock.Packages {
			if pp.Name == p.Name && pp.Version == p.Version.String() {
				return
			}
		}

		lock.Packages = append(lock.Packages, p.toJSON())

		if len(p.Dependencies) > 0 {
			lock.addPackagesToLock(p.Dependencies)
		}
	}
}

func (installation *Installation) loadDirectPackages() []*Package {
	directPackages := []*Package{}
	packagesJsonFile := path.Join(installation.BaseDirectory, "package.json")
	exists, isFile := fs.Exists(packagesJsonFile)

	if !exists || !isFile {
		return directPackages
	}

	packageJsonData, err := fs.ReadFile(packagesJsonFile)
	if err != nil {
		fmt.Println(err)
		return directPackages
	}

	packageJson := &PackageJSON{}
	err = json.Unmarshal(packageJsonData, packageJson)
	if err != nil {
		fmt.Println(err)
		return directPackages
	}

	if packageJson.Dependencies != nil {
		for n, v := range packageJson.Dependencies {
			p := installation.NewPackageWithVersionStr(n, v)
			p.VersionOriginal = v
			p.Direct = true
			directPackages = append(directPackages, &p)
		}
	}

	if packageJson.DevDependencies != nil {
		for n, v := range packageJson.DevDependencies {
			p := installation.NewPackageWithVersionStr(n, v)
			p.VersionOriginal = v
			p.Direct = true
			p.Dev = true
			directPackages = append(directPackages, &p)
		}
	}

	return directPackages
}

func (installation *Installation) loadLocalPackages() {
	installation.LocalPackages = []PackageLockJSON{}
	lockFile := path.Join(installation.BaseDirectory, "lock.json")
	exists, isFile := fs.Exists(lockFile)
	if !exists || !isFile {
		return
	}

	lockData, err := fs.ReadFile(lockFile)

	if err != nil {
		fmt.Println(err)
		return
	}

	lock := &PackageLock{}
	err = json.Unmarshal(lockData, lock)

	if err != nil {
		fmt.Println(err)
		return
	}

	installation.LocalPackages = lock.Packages
}

func mergeSlices(arr1 []string, arr2 []string) []string {
	for _, b := range arr2 {
		seen := false
		for _, a := range arr1 {
			if a == b {
				seen = true
				break
			}
		}
		if !seen {
			arr1 = append(arr1, b)
		}
	}
	return arr1
}

func appendIfContainsNot(arr []string, e string) []string {
	if slices.Contains(arr, e) {
		return arr
	}

	return append(arr, e)
}
