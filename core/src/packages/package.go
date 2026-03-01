package packages

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	fs "fullstackedorg/fullstacked/src/fs"
	"fullstackedorg/fullstacked/src/git"
	setup "fullstackedorg/fullstacked/src/setup"
	"fullstackedorg/fullstacked/src/utils"
	"io"
	"net/http"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	semver "github.com/Masterminds/semver/v3"
)

type Package struct {
	Name            string          `json:"name"`
	Version         *semver.Version `json:"version"`
	VersionOriginal string          `json:"-"`
	GitRefType      git.RefType     `json:"-"`
	GitTmpDir       string          `json:"-"`
	As              []string        `json:"-"`
	Direct          bool            `json:"-"`
	Dev             bool            `json:"-"`

	Locations []string `json:"-"`

	InstallationId float64 `json:"id"`

	Dependants   []*Package `json:"-"`
	Dependencies []*Package `json:"-"`

	Progress struct {
		Stage  string `json:"stage"`
		Loaded int    `json:"loaded"`
		Total  int    `json:"total"`
	} `json:"progress"`
}

type PackageJSON struct {
	Name            string            `json:"name"`
	Version         string            `json:"version"`
	Dependencies    map[string]string `json:"dependencies"`
	DevDependencies map[string]string `json:"devDependencies"`
}

type PackageLockJSON struct {
	Name      string      `json:"name"`
	Version   string      `json:"version"`
	Git       git.RefType `json:"git,omitempty"`
	As        []string    `json:"as,omitempty"`
	Locations []string    `json:"location"`
}

func (p *Package) toJSON() PackageLockJSON {
	pJson := PackageLockJSON{
		Name:      p.Name,
		As:        p.As,
		Locations: p.Locations,
		Version:   p.Version.String(),
	}
	if p.GitRefType != "" {
		pJson.Git = p.GitRefType
	}
	return pJson
}

// for downloading progress
func (p *Package) Write(data []byte) (int, error) {
	n := len(data)
	p.Progress.Loaded += n
	p.notify()
	return n, nil
}

func (p *Package) notify() {
	jsonData, err := json.Marshal(p)
	if err != nil {
		fmt.Println(err)
		return
	}

	jsonStr := string(jsonData)

	setup.Callback("", "packages-installation", jsonStr)
}

type Dependencies struct {
	packages []Package
}

func (p *Package) getDependencies(i *Installation) []Package {
	if p.Version == nil {
		panic("trying to get dependencies without resolved version [" + p.Name + "]")
	}

	dependencies := Dependencies{
		packages: []Package{},
	}

	deps := p.getDependenciesList(i)

	if deps == nil {
		return dependencies.packages
	}

	wg := sync.WaitGroup{}
	mutex := sync.Mutex{}
	for n, v := range deps {
		wg.Add(1)
		go NewDependency(i, p, n, v, &dependencies, &wg, &mutex)
	}
	wg.Wait()

	return dependencies.packages
}

func (p *Package) getDependenciesList(i *Installation) map[string]string {
	for _, pp := range i.LocalPackages {
		if pp.Name != p.Name || pp.Version != p.Version.String() {
			continue
		}

		for _, l := range pp.Locations {
			pDir := path.Join(i.BaseDirectory, l, p.Name)
			ppp := i.NewPackageFromLock(pp.Name, p.Version, pp.As, pp.Git)
			if ppp.isInstalled(pDir) {
				return ppp.getDependenciesFromLocal(pDir)
			}
		}
	}

	// git package not in local packages
	if p.GitRefType != "" {
		// not been cloned
		if p.GitTmpDir == "" {
			// clone success
			if p.cloneAndCheckoutGitPackageToTmp() {
				return p.getDependenciesFromGitPackage()
			} else {
				return map[string]string{}
			}
		}
		return p.getDependenciesFromGitPackage()
	}

	return p.getDependenciesFromRemote()
}

func (p *Package) getDependenciesFromLocal(directory string) map[string]string {
	packageJsonFile := path.Join(directory, "package.json")

	packageJsonData, err := fs.ReadFile(packageJsonFile)

	if err != nil {
		return nil
	}

	packageJson := &PackageJSON{}
	err = json.Unmarshal(packageJsonData, packageJson)

	if err != nil {
		return nil
	}

	return packageJson.Dependencies
}

func (p *Package) getDependenciesFromRemote() map[string]string {
	npmPackageInfo, err := http.Get("https://registry.npmjs.org/" + p.Name + "/" + p.Version.String())
	if err != nil {
		fmt.Println(err)
		return nil
	}
	defer npmPackageInfo.Body.Close()

	npmPackageInfoJSON := &npmPackageInfoVersion{}
	err = json.NewDecoder(npmPackageInfo.Body).Decode(npmPackageInfoJSON)
	if err != nil {
		fmt.Println(err)
		return nil
	}

	return npmPackageInfoJSON.Dependencies
}

func NewDependency(
	installation *Installation,
	dependant *Package,
	name string,
	versionStr string,
	dependencies *Dependencies,
	wg *sync.WaitGroup,
	mutex *sync.Mutex,
) {
	defer wg.Done()
	p := installation.NewPackageWithVersionStr(name, versionStr)
	p.Dependants = []*Package{dependant}
	mutex.Lock()
	dependencies.packages = append(dependencies.packages, p)
	mutex.Unlock()
}

func (p *Package) isInstalled(directory string) bool {
	packageJsonFile := path.Join(directory, "package.json")
	exists, isFile := fs.Exists(packageJsonFile)

	if !exists || !isFile {
		return false
	}

	packageJson := &PackageJSON{}
	packageJsonData, err := fs.ReadFile(packageJsonFile)

	if err != nil {
		fmt.Println(err)
		return false
	}

	err = json.Unmarshal(packageJsonData, packageJson)

	if err != nil {
		fmt.Println(err)
		return false
	}

	if packageJson.Name != p.Name {
		return false
	}

	if p.GitRefType != "" {
		return p.GitTmpDir == "" && p.isPackageGitOnRef(directory)
	}

	installedVersion, err := semver.NewVersion(packageJson.Version)

	if err != nil || installedVersion == nil {
		fmt.Println(err)
		return false
	}

	return installedVersion.Equal(p.Version)
}

// gitUrl: [SCHEME:]hostname[:PORT]:repo/name[#HASH|TAG|BRANCH]
func (p *Package) isPackageGitOnRef(directory string) bool {
	gitUrl := p.As[0]
	if !strings.Contains(gitUrl, "#") && p.GitRefType == git.GIT_DEFAULT {
		return true
	}

	urlComponents := strings.Split(gitUrl, "#")
	ref := urlComponents[len(urlComponents)-1]

	return git.IsOnRef(directory, ref, p.GitRefType)
}

func (p *Package) Install(
	i *Installation,
	directory string,
	wg *sync.WaitGroup,
	mutex *sync.Mutex,
) {
	defer wg.Done()

	// fullstacked must never install fullstacked
	if p.Name == "fullstacked" {
		return
	}

	pLocation := path.Join(directory, p.Name)
	pDir := path.Join(i.BaseDirectory, pLocation)

	if p.Locations == nil {
		p.Locations = []string{}
	}
	p.Locations = append(p.Locations, directory)

	if !p.isInstalled(pDir) {
		mutex.Lock()
		i.PackagesInstalledCount += 1
		mutex.Unlock()

		if p.GitRefType != "" {
			p.installFromGit(pDir)
		} else {
			p.installFromRemote(pDir)
		}
	} else if !i.Quick && (p.GitRefType == git.GIT_BRANCH || p.GitRefType == git.GIT_DEFAULT) {
		git.Pull(pDir, i.ProjectId == "", i.ProjectId)
		p.updateNameAndVersionWithPackageJSON(pDir)
	}

	if len(p.Dependencies) > 0 {
		for _, dep := range p.Dependencies {
			wg.Add(1)
			go dep.Install(i, path.Join(pLocation, "node_modules"), wg, mutex)
		}
	}
}

func (p *Package) installFromRemote(directory string) {
	// clean
	exists, _ := fs.Exists(directory)
	if exists {
		fs.Rmdir(directory, fileEventOrigin)
	}
	fs.Mkdir(directory, fileEventOrigin)

	npmPackageInfo, err := http.Get("https://registry.npmjs.org/" + p.Name + "/" + p.Version.String())
	if err != nil {
		fmt.Println(err)
		return
	}
	defer npmPackageInfo.Body.Close()

	npmPackageInfoJSON := &npmPackageInfoVersion{}
	err = json.NewDecoder(npmPackageInfo.Body).Decode(npmPackageInfoJSON)
	if err != nil {
		fmt.Println(err)
		return
	}

	tarballUrl := npmPackageInfoJSON.Dist.Tarball
	tarballResponse, err := http.Get(tarballUrl)
	if err != nil {
		fmt.Println("failed to get tarball url")
		return
	}
	defer tarballResponse.Body.Close()

	// download tarball
	dlTotal, _ := strconv.Atoi(tarballResponse.Header.Get("content-length"))
	p.Progress.Stage = "downloading"
	p.Progress.Loaded = 0
	p.Progress.Total = dlTotal
	p.notify()
	dlReader := io.TeeReader(tarballResponse.Body, p)
	packageDataGZIP, _ := io.ReadAll(dlReader)

	p.Progress.Stage = "unpacking"
	p.Progress.Loaded = 0
	p.Progress.Total = 0
	p.notify()

	// get item count
	packageDataGZIPBufferCount := bytes.NewBuffer(packageDataGZIP)
	gunzipReaderCount, _ := gzip.NewReader(packageDataGZIPBufferCount)
	defer gunzipReaderCount.Close()

	tarReaderCount := tar.NewReader(gunzipReaderCount)
	totalItemCount := 0
	for {
		_, err := tarReaderCount.Next()
		if err == io.EOF {
			break
		}
		totalItemCount += 1
	}
	p.Progress.Total = totalItemCount
	p.notify()

	// untar
	packageDataGZIPBuffer := bytes.NewBuffer(packageDataGZIP)
	gunzipReader, _ := gzip.NewReader(packageDataGZIPBuffer)
	defer gunzipReader.Close()

	tarReader := tar.NewReader(gunzipReader)

	for {
		header, err := tarReader.Next()

		if err == io.EOF {
			break
		}

		if header != nil {

			// strip 1
			filePath := strings.Join(strings.Split(header.Name, "/")[1:], "/")

			target := path.Join(directory, filePath)

			if !strings.Contains(target, "..") {

				switch header.Typeflag {
				case tar.TypeDir:
					fs.Mkdir(target, fileEventOrigin)
				case tar.TypeReg:
					dir, _ := path.Split(target)
					fs.Mkdir(dir, fileEventOrigin)
					fileData, _ := io.ReadAll(tarReader)
					fs.WriteFile(target, fileData, fileEventOrigin)
				}

			}

		}

		p.Progress.Loaded += 1
		p.notify()
	}

	p.Progress.Stage = "done"
	p.Progress.Loaded = 1
	p.Progress.Total = 1
	p.notify()
}

func (p *Package) updateNameAndVersionWithPackageJSON(directory string) {
	packageJsonPath := path.Join(directory, "package.json")
	exists, isFile := fs.Exists(packageJsonPath)
	if !exists || !isFile {
		fmt.Println("no package.json in package")
		return
	}

	packageJsonData, err := fs.ReadFile(packageJsonPath)
	if err != nil {
		fmt.Println(err)
		return
	}

	packageJson := &PackageJSON{}
	err = json.Unmarshal(packageJsonData, packageJson)
	if err != nil {
		fmt.Println(err)
		return
	}

	p.Name = packageJson.Name
	v, err := semver.NewVersion(packageJson.Version)
	if err != nil {
		fmt.Println("bad version in package")
		v = nil
	}
	p.Version = v
}

func (p *Package) cloneAndCheckoutGitPackageToTmp() bool {
	url := pseudoGitUrlToUrl(p.As[0])

	ref := ""
	if strings.Contains(p.As[0], "#") {
		repoComponents := strings.Split(p.As[0], "#")
		ref = repoComponents[len(repoComponents)-1]
	}

	p.GitTmpDir = path.Join(setup.Directories.Tmp, utils.RandString(6))

	git.Clone(p.GitTmpDir, url.String())
	p.GitRefType = git.CheckoutRef(p.GitTmpDir, ref, p.GitRefType)

	p.updateNameAndVersionWithPackageJSON(p.GitTmpDir)

	invalidatePackage := func() {
		fs.Rmdir(p.GitTmpDir, fileEventOrigin)
		p.GitTmpDir = ""
	}

	if p.Name == "" {
		fmt.Println("missing name in git package")
		invalidatePackage()
		return false
	} else if p.Version == nil {
		fmt.Println("missing version in git package")
		invalidatePackage()
		return false
	}

	return true
}

func (p *Package) getDependenciesFromGitPackage() map[string]string {
	if p.GitTmpDir == "" {
		fmt.Println("trying to get git package deps before cloning to tmp")
		return map[string]string{}
	}

	packageJsonPath := path.Join(p.GitTmpDir, "package.json")
	exists, isFile := fs.Exists(packageJsonPath)
	if !exists || !isFile {
		fmt.Println("no package.json in git package")
		return map[string]string{}
	}

	packageJsonData, err := fs.ReadFile(packageJsonPath)
	if err != nil {
		fmt.Println(err)
		return map[string]string{}
	}

	packageJson := &PackageJSON{}
	err = json.Unmarshal(packageJsonData, packageJson)

	if err != nil {
		fmt.Println(err)
		return map[string]string{}
	}

	return packageJson.Dependencies
}

// gitUrl: [SCHEME:]hostname[:PORT]:repo/name[#HASH|TAG|BRANCH]
func (p *Package) installFromGit(directory string) {
	if p.GitTmpDir == "" {
		p.cloneAndCheckoutGitPackageToTmp()
	}

	parentDir := filepath.Dir(directory)

	fs.Mkdir(parentDir, fileEventOrigin)
	fs.Rmdir(directory, fileEventOrigin)
	fs.Rename(p.GitTmpDir, directory, fileEventOrigin)
}
