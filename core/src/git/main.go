package git

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/go-git/go-billy/v5"
	"github.com/go-git/go-billy/v5/osfs"
	git "github.com/go-git/go-git/v5"
	gitConfig "github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/cache"
	"github.com/go-git/go-git/v5/plumbing/format/gitignore"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/transport"
	"github.com/go-git/go-git/v5/plumbing/transport/http"
	"github.com/go-git/go-git/v5/storage/filesystem"

	config "fullstackedorg/fullstacked/src/config"
	fs "fullstackedorg/fullstacked/src/fs"
	serialize "fullstackedorg/fullstacked/src/serialize"
	setup "fullstackedorg/fullstacked/src/setup"
	utils "fullstackedorg/fullstacked/src/utils"
)

var ignored = []string{
	"/.build",
	"/data",
	"/node_modules",
	"/chat",
	"/tsconfig.json",
}

type GitMessageJSON struct {
	Url      string `json:"url"`
	Data     string `json:"data"`
	Error    bool   `json:"error"`
	Finished bool   `json:"finished"`
}

func errorFmt(e error) string {
	gitError := GitMessageJSON{
		Data:  strings.ReplaceAll(strings.TrimSpace(e.Error()), "\"", "\\\""),
		Error: true,
	}
	jsonData, _ := json.Marshal(gitError)
	jsonStr := string(jsonData)
	return jsonStr
}

func getRepo(directory string, wg *sync.WaitGroup) (*git.Repository, error) {
	repo := (*git.Repository)(nil)
	err := (error)(nil)

	dotDir := path.Join(directory, ".git")
	gitFs := (billy.Filesystem)(nil)
	if fs.WASM {
		gitStorage := newStorage(dotDir, wg)
		gitFs = NewBillyFS(gitStorage, []string{})
	} else {
		gitFs = osfs.New(dotDir)
	}

	repoStorage := newStorage(directory, wg)
	repoFs := NewBillyFS(repoStorage, ignored)

	repo, err = git.Open(filesystem.NewStorage(gitFs, cache.NewObjectLRUDefault()), repoFs)

	if err != nil {
		return nil, err
	}

	return repo, nil
}

func getWorktree(repo *git.Repository) (*git.Worktree, error) {
	worktree, err := repo.Worktree()

	if err != nil {
		return nil, err
	}

	// always ignore FullStacked artifacts
	for _, d := range ignored {
		worktree.Excludes = append(worktree.Excludes, gitignore.ParsePattern(d, []string{}))
	}

	return worktree, nil
}

type GitProgress struct {
	ProjectId string
	Name      string
	Url       string
}

func (gitProgress *GitProgress) Write(p []byte) (int, error) {
	n := len(p)

	jsonData, _ := json.Marshal(GitMessageJSON{
		Url:      gitProgress.Url,
		Data:     strings.TrimSpace(string(p)),
		Error:    false,
		Finished: false,
	})

	setup.Callback(gitProgress.ProjectId, gitProgress.Name, string(jsonData))
	return n, nil
}

func (gitProgress *GitProgress) End(pullResponse string, isError bool) {
	jsonData, _ := json.Marshal(GitMessageJSON{
		Url:      gitProgress.Url,
		Data:     pullResponse,
		Error:    isError,
		Finished: true,
	})

	setup.Callback(gitProgress.ProjectId, gitProgress.Name, string(jsonData))
}

func (gitProgress *GitProgress) Error(message string) {
	jsonData, _ := json.Marshal(GitMessageJSON{
		Url:      gitProgress.Url,
		Data:     strings.ReplaceAll(strings.TrimSpace(message), "\"", "\\\""),
		Error:    true,
		Finished: true,
	})

	setup.Callback(gitProgress.ProjectId, gitProgress.Name, string(jsonData))
}

// ref: editor/types/index.ts
type GitAuth struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type GitAuthConfig = map[string]GitAuth

func checkForGitAuth(urlStr string) *http.BasicAuth {
	gitUrl, err := url.Parse(urlStr)
	if err != nil {
		fmt.Println(err)
		return nil
	}

	gitConfig := GitAuthConfig{}
	gitConfigData, err := config.Get("git")

	if err != nil {
		return nil
	}

	err = json.Unmarshal(gitConfigData, &gitConfig)

	if err != nil {
		fmt.Println(err)
		return nil
	}

	gitAuth, ok := gitConfig[gitUrl.Host]

	if !ok {
		return nil
	}

	return &http.BasicAuth{
		Username: gitAuth.Username,
		Password: gitAuth.Password,
	}
}

type GitAuthRequest struct {
	Id        string          `json:"id"`
	Host      string          `json:"host"`
	Canceled  bool            `json:"-"`
	WaitGroup *sync.WaitGroup `json:"-"`
}

var activeGitAuthRequests = map[string]GitAuthRequest{}

// returns success
func requestGitAuthentication(urlStr string) bool {
	gitUrl, err := url.Parse(urlStr)
	if err != nil {
		fmt.Println(err)
		return false
	}

	wg := sync.WaitGroup{}

	authRequest := GitAuthRequest{
		Id:        utils.RandString(10),
		Host:      gitUrl.Host,
		WaitGroup: &wg,
	}

	activeGitAuthRequests[authRequest.Id] = authRequest

	wg.Add(1)

	jsonData, _ := json.Marshal(authRequest)
	jsonStr := string(jsonData)
	setup.Callback("", "git-authentication", jsonStr)

	wg.Wait()
	defer delete(activeGitAuthRequests, authRequest.Id)

	return !authRequest.Canceled
}

func AuthResponse(id string, canceled bool) {
	authRequest, ok := activeGitAuthRequests[id]

	if !ok {
		return
	}

	authRequest.Canceled = canceled
	activeGitAuthRequests[authRequest.Id] = authRequest
	authRequest.WaitGroup.Done()
}

func HasGit(dir string) bool {
	exists, isFile := fs.Exists(path.Join(dir, ".git"))
	return exists && !isFile
}

func RemoteURL(dir string) string {
	if !HasGit(dir) {
		return ""
	}

	wg := sync.WaitGroup{}

	repo, err := getRepo(dir, &wg)

	if err != nil {
		return ""
	}

	remote, err := repo.Remote("origin")

	if err != nil {
		return ""
	}

	wg.Wait()

	return remote.Config().URLs[0]
}

func Clone(into string, url string) {
	progress := GitProgress{
		Name: "git-clone",
		Url:  url,
	}

	wg := sync.WaitGroup{}

	dotDir := path.Join(into, ".git")
	gitFs := (billy.Filesystem)(nil)
	if fs.WASM {
		gitStorage := newStorage(dotDir, &wg)
		gitFs = NewBillyFS(gitStorage, []string{})
	} else {
		gitFs = osfs.New(dotDir)
	}

	repoStorage := newStorage(into, &wg)
	repoFs := NewBillyFS(repoStorage, ignored)

	storage := filesystem.NewStorage(gitFs, cache.NewObjectLRUDefault())

	_, err := git.Clone(filesystem.NewStorage(gitFs, cache.NewObjectLRUDefault()), repoFs, &git.CloneOptions{
		Auth:     checkForGitAuth(url),
		URL:      url,
		Progress: &progress,
	})

	if err == transport.ErrEmptyRemoteRepository {
		fs.Rmdir(into, fileEventOrigin)
		fs.Mkdir(into, fileEventOrigin)
		repo, _ := git.InitWithOptions(storage, repoFs, git.InitOptions{
			DefaultBranch: plumbing.Main,
		})
		repo.CreateRemote(&gitConfig.RemoteConfig{
			Name: "origin",
			URLs: []string{url},
		})
		err = nil
	}

	if err != nil && strings.HasPrefix(err.Error(), "authentication required") {
		if requestGitAuthentication(url) {
			fs.Rmdir(into, fileEventOrigin)
			_, err = git.Clone(filesystem.NewStorage(gitFs, cache.NewObjectLRUDefault()), repoFs, &git.CloneOptions{
				Auth:     checkForGitAuth(url),
				URL:      url,
				Progress: &progress,
			})
		}
	}

	if err != nil {
		progress.Error(err.Error())
		fs.Rmdir(into, fileEventOrigin)
		return
	}

	wg.Wait()

	progress.Write([]byte("done"))
}

func HeadSerialized(directory string) []byte {
	branch := ""
	hash := ""

	head, err := Head(directory)
	if err != nil {
		if err == plumbing.ErrReferenceNotFound {
			branch = "main"
			hash = "-"
		} else {
			return serialize.SerializeString(errorFmt(err))
		}
	} else {
		branch = head.Name().Short()
		hash = head.Hash().String()
	}

	data := []byte{}
	data = append(data, serialize.SerializeString(branch)...)
	data = append(data, serialize.SerializeString(hash)...)
	return data
}

func Head(directory string) (*plumbing.Reference, error) {
	wg := sync.WaitGroup{}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		return nil, err
	}

	head, err := repo.Head()

	if err != nil {
		return nil, err
	}

	wg.Wait()

	return head, nil
}

func Status(directory string) []byte {
	wg := sync.WaitGroup{}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	worktree, err := getWorktree(repo)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	err = worktree.AddGlob(".")
	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	wg.Wait()

	status, err := worktree.Status()
	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	data := []byte{}

	// added: 0, deleted: 1, modified: 2,
	for file, fileStatus := range status {
		data = append(data, serialize.SerializeString(file)...)
		switch fileStatus.Staging {
		case git.Added, git.Copied:
			// added
			data = append(data, serialize.SerializeNumber(0)...)
		case git.Deleted:
			// deleted
			data = append(data, serialize.SerializeNumber(1)...)
		default:
			// modified
			data = append(data, serialize.SerializeNumber(2)...)
		}
	}

	return data
}

func Pull(directory string, isEditor bool, projectId string) {
	progress := GitProgress{
		ProjectId: projectId,
		Name:      "git-pull",
	}

	wg := sync.WaitGroup{}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		progress.Error(err.Error())
		return
	}

	remote, err := repo.Remote("origin")

	if err != nil {
		progress.Error(err.Error())
		return
	}

	progress.Url = remote.Config().URLs[0]

	worktree, err := getWorktree(repo)

	if err != nil {
		progress.Error(err.Error())
		return
	}

	err = worktree.AddGlob(".")
	if err != nil {
		progress.Error(err.Error())
		return
	}

	wg.Wait()

	status, err := worktree.Status()

	if err != nil {
		progress.Error(err.Error())
		return
	}

	if !status.IsClean() {
		progress.Error("has changes")
		return
	}

	wg.Wait()

	if !utils.IsReacheable(progress.Url) {
		progress.Error("unreacheable")
		return
	}

	progress.Write([]byte("start"))

	err = worktree.AddGlob(".")
	if err != nil {
		progress.Error(err.Error())
		return
	}

	wg.Wait()

	head, err := repo.Head()

	if err != nil {
		progress.Error(err.Error())
		return
	}

	wg.Wait()

	err = worktree.Pull(&git.PullOptions{
		Auth:          checkForGitAuth(progress.Url),
		ReferenceName: head.Name(),
		Progress:      &progress,
	})

	// request git auth only when Editor,
	// else, the auth should already be setup
	if err != nil && strings.HasPrefix(err.Error(), "authentication required") && isEditor {
		if requestGitAuthentication(progress.Url) {
			err = worktree.Pull(&git.PullOptions{
				Auth:          checkForGitAuth(progress.Url),
				ReferenceName: head.Name(),
				Progress:      &progress,
			})
		}
	}

	pullResponse := ""

	if err != nil {
		pullResponse = err.Error()
	}

	wg.Wait()

	headAfter, err := Head(directory)

	if err != nil {
		progress.Error(err.Error())
		return
	}

	if head.Hash().String() == headAfter.Hash().String() {
		pullResponse = "already up-to-date"
	}

	progress.End(pullResponse, err != nil)
}

func Push(directory string) {
	wg := sync.WaitGroup{}

	progress := GitProgress{
		Name: "git-push",
	}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		progress.Error(err.Error())
		return
	}

	remote, err := repo.Remote("origin")

	if err != nil {
		progress.Error(err.Error())
		return
	}

	wg.Wait()

	progress.Url = remote.Config().URLs[0]

	progress.Write([]byte("start"))

	err = repo.Push(&git.PushOptions{
		Auth: checkForGitAuth(progress.Url),
		Progress: &GitProgress{
			Name: "git-push",
		},
	})

	if err != nil && strings.HasPrefix(err.Error(), "authentication required") {
		if requestGitAuthentication(progress.Url) {
			err = repo.Push(&git.PushOptions{
				Auth: checkForGitAuth(progress.Url),
				Progress: &GitProgress{
					Name: "git-push",
				},
			})
		}
	}

	if err != nil {
		progress.Error(err.Error())
		return
	}

	wg.Wait()

	progress.End("", false)
}

func Restore(directory string, files []string) []byte {
	wg := sync.WaitGroup{}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	worktree, err := getWorktree(repo)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	err = worktree.Restore(&git.RestoreOptions{
		Staged:   true,
		Worktree: true,
		Files:    files,
	})

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	wg.Wait()

	return nil
}

func Fetch(directory string) []byte {
	wg := sync.WaitGroup{}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	remote, _ := repo.Remote("origin")

	err = repo.Fetch(&git.FetchOptions{
		Auth: checkForGitAuth(remote.Config().URLs[0]),
	})

	if err != nil && strings.HasPrefix(err.Error(), "authentication required") {
		if requestGitAuthentication(remote.Config().URLs[0]) {
			err = repo.Fetch(&git.FetchOptions{
				Auth: checkForGitAuth(remote.Config().URLs[0]),
			})
		}
	}

	if err != nil && err.Error() != "already up-to-date" {
		return serialize.SerializeString(errorFmt(err))
	}

	wg.Wait()

	return nil
}

func Commit(directory string, commitMessage string, authorName string, authorEmail string) []byte {
	wg := sync.WaitGroup{}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	worktree, err := getWorktree(repo)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	_, err = worktree.Commit(commitMessage, &git.CommitOptions{
		All: true,
		Author: &object.Signature{
			Name:  authorName,
			Email: authorEmail,
			When:  time.Now(),
		},
	})

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	wg.Wait()

	return nil
}

func getRemoteBranches(directory string) ([]plumbing.Reference, error) {
	wg := sync.WaitGroup{}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		return nil, err
	}

	remote, err := repo.Remote("origin")

	if err != nil {
		return nil, err
	}

	remoteRefs, err := remote.List(&git.ListOptions{
		Auth: checkForGitAuth(remote.Config().URLs[0]),
	})

	if err != nil && strings.HasPrefix(err.Error(), "authentication required") {
		if requestGitAuthentication(remote.Config().URLs[0]) {
			remoteRefs, err = remote.List(&git.ListOptions{
				Auth: checkForGitAuth(remote.Config().URLs[0]),
			})
		}
	}

	if err != nil {
		return nil, err
	}

	remoteBranches := []plumbing.Reference{}
	for _, r := range remoteRefs {
		if r.Name().IsBranch() {
			remoteBranches = append(remoteBranches, *r)
		}
	}

	wg.Wait()

	return remoteBranches, nil
}

type Branch struct {
	Name   string
	Local  bool
	Remote bool
}

func Branches(directory string) []byte {
	remoteBranches, err := getRemoteBranches(directory)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	branches := []Branch{}

	for _, r := range remoteBranches {
		branches = append(branches, Branch{
			Name:   r.Name().Short(),
			Remote: true,
			Local:  false,
		})
	}

	wg := sync.WaitGroup{}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	localRefs, err := repo.Branches()
	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	wg.Wait()

	localRefs.ForEach(func(r *plumbing.Reference) error {
		for i := range branches {
			if branches[i].Name == r.Name().Short() {
				branches[i].Local = true
				return nil
			}
		}

		branches = append(branches, Branch{
			Name:   r.Name().Short(),
			Remote: false,
			Local:  true,
		})
		return nil
	})

	branchesSerialized := []byte{}

	for _, b := range branches {
		branchesSerialized = append(branchesSerialized, serialize.SerializeString(b.Name)...)
		branchesSerialized = append(branchesSerialized, serialize.SerializeBoolean(b.Remote)...)
		branchesSerialized = append(branchesSerialized, serialize.SerializeBoolean(b.Local)...)
	}

	return branchesSerialized
}

type RefType string

const (
	GIT_DEFAULT = "default"
	GIT_BRANCH  = "branch"
	GIT_TAG     = "tag"
	GIT_COMMIT  = "commit"
)

func IsOnRef(directory string, ref string, refType RefType) bool {
	if ref == "" {
		return true
	}

	wg := sync.WaitGroup{}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		return false
	}

	wg.Wait()

	head, err := repo.Head()

	if err != nil {
		return false
	}

	if refType == GIT_BRANCH {
		return head.Name().Short() == ref
	} else if refType == GIT_COMMIT {
		return head.Hash().String() == ref
	}

	// GIT_TAG
	isOnTag := false
	tags, err := repo.Tags()
	if err == nil {
		tags.ForEach(func(r *plumbing.Reference) error {
			if r.Name().Short() == ref && r.Hash().String() == head.Hash().String() {
				isOnTag = true
			}
			return nil
		})
	}

	return isOnTag
}

func findRefType(directory string, ref string) RefType {
	if ref == "" {
		return GIT_DEFAULT
	}

	wg := sync.WaitGroup{}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		return GIT_DEFAULT
	}

	wg.Wait()

	remoteBranches, err := getRemoteBranches(directory)
	if err == nil {
		for _, b := range remoteBranches {
			if b.Name().Short() == ref {
				return GIT_BRANCH
			}
		}
	}

	tags, err := repo.Tags()
	if err == nil {
		isTag := false
		tags.ForEach(func(r *plumbing.Reference) error {
			if r.Name().Short() == ref {
				isTag = true
			}
			return nil
		})
		if isTag {
			return GIT_TAG
		}
	}

	return GIT_COMMIT
}

func CheckoutRef(
	directory string,
	ref string,
	refType RefType,
) RefType {
	if refType == "" {
		refType = findRefType(directory, ref)
	}

	if refType == GIT_DEFAULT {
		return refType
	}

	wg := sync.WaitGroup{}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		return refType
	}

	wg.Wait()

	worktree, err := getWorktree(repo)

	if err != nil {
		return refType
	}

	worktree.AddGlob(".")
	wg.Wait()

	switch refType {
	case GIT_BRANCH:
		err = worktree.Checkout(&git.CheckoutOptions{
			Branch: plumbing.NewBranchReferenceName(ref),
		})
	case GIT_COMMIT:
		err = worktree.Checkout(&git.CheckoutOptions{
			Hash: plumbing.NewHash(ref),
		})
	case GIT_TAG:
		tags, tagsErr := repo.Tags()
		if tagsErr == nil {
			hash := plumbing.Hash{}

			tags.ForEach(func(r *plumbing.Reference) error {
				if r.Name().Short() == ref {
					hash = r.Hash()
				}
				return nil
			})

			if hash.IsZero() {
				err = errors.New("could not find tag in repository")
			} else {
				err = worktree.Checkout(&git.CheckoutOptions{
					Hash: hash,
				})
			}
		} else {
			err = tagsErr
		}
	}

	if err != nil {
		fmt.Println(err)
	}

	wg.Wait()

	return refType
}

func Checkout(
	directory string,
	branch string,
	create bool,
) []byte {
	wg := sync.WaitGroup{}
	branchRefName := (*plumbing.ReferenceName)(nil)

	repo, err := getRepo(directory, &wg)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	localBranches, err := repo.Branches()

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}
	wg.Wait()

	localBranches.ForEach(func(r *plumbing.Reference) error {
		if r.Name().Short() == branch {
			rName := r.Name()
			branchRefName = &rName
		}
		return nil
	})

	remoteBranches, err := getRemoteBranches(directory)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	refOnRemote := false
	for _, r := range remoteBranches {
		if r.Name().IsBranch() && r.Name().Short() == branch {
			rName := r.Name()
			branchRefName = &rName
			refOnRemote = true
			break
		}
	}

	if refOnRemote {
		remote, err := repo.Remote("origin")

		if err != nil {
			return serialize.SerializeString(errorFmt(err))
		}

		refSpec := []gitConfig.RefSpec{gitConfig.RefSpec(branchRefName.String() + ":" + branchRefName.String())}

		err = remote.Fetch(&git.FetchOptions{
			Auth:     checkForGitAuth(remote.Config().URLs[0]),
			RefSpecs: refSpec,
		})

		if err != nil && strings.HasPrefix(err.Error(), "authentication required") {
			if requestGitAuthentication(remote.Config().URLs[0]) {
				err = remote.Fetch(&git.FetchOptions{
					Auth:     checkForGitAuth(remote.Config().URLs[0]),
					RefSpecs: refSpec,
				})
			}
		}

		if err != nil && err.Error() != "already up-to-date" {
			return serialize.SerializeString(errorFmt(err))
		}

		wg.Wait()
	}

	worktree, err := getWorktree(repo)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	if branchRefName == nil {
		rName := plumbing.NewBranchReferenceName(branch)
		branchRefName = &rName
	}

	wg.Wait()

	// add all before checking out to prevent
	// changing branch with unstaged changes
	if !create {
		worktree.AddGlob(".")
		wg.Wait()
	}

	err = worktree.Checkout(&git.CheckoutOptions{
		Branch: *branchRefName,
		Create: create,
	})

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	wg.Wait()

	return nil
}

func BranchDelete(directory string, branch string) []byte {
	wg := sync.WaitGroup{}

	repo, err := getRepo(directory, &wg)

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	err = repo.Storer.RemoveReference(plumbing.NewBranchReferenceName(branch))

	if err != nil {
		return serialize.SerializeString(errorFmt(err))
	}

	wg.Wait()

	return nil
}
