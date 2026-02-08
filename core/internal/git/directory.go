package git

import (
	"errors"
	"fullstackedorg/fullstacked/types"

	git "github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/config"
	"github.com/go-git/go-git/v6/plumbing"
)

type GitDirectory struct {
	Directory  string
	repository *git.Repository
	worktree   *git.Worktree
}

func OpenGitDirectory(directory string) (*GitDirectory, error) {
	repository, err := git.PlainOpen(directory)

	if err != nil {
		return nil, err
	}

	gitRepository := GitDirectory{
		Directory:  directory,
		repository: repository,
	}

	return &gitRepository, nil
}

func (r *GitDirectory) Repository() (*git.Repository, error) {
	if r.repository != nil {
		return r.repository, nil
	}

	repository, err := git.PlainOpen(r.Directory)

	if err != nil {
		return nil, err
	}

	r.repository = repository

	return r.repository, nil
}

func (r *GitDirectory) Worktree() (*git.Worktree, error) {
	if r.worktree != nil {
		return r.worktree, nil
	}

	worktree, err := r.repository.Worktree()

	if err != nil {
		return nil, err
	}

	r.worktree = worktree

	return r.worktree, nil
}

func (r *GitDirectory) LsRemote(ctx *types.CoreCallContext, remoteName string) ([]*plumbing.Reference, error) {
	urlStr, err := r.GetUrl()

	if err != nil {
		return nil, err
	}

	err = testHost(urlStr)

	if err != nil {
		return nil, err
	}

	repository, err := r.Repository()

	if err != nil {
		return nil, err
	}

	remote, err := repository.Remote(remoteName)

	if err != nil {
		return nil, err
	}

	options := git.ListOptions{}

	auth, _ := RequestAuth(ctx, urlStr, false)

	options.Auth = gitAuthToHttpAuth(auth)

	refs, err := remote.List(&options)

	if errIsAuthenticationRequired(err) {
		auth, err = RequestAuth(ctx, urlStr, true)

		if err == nil {
			options.Auth = gitAuthToHttpAuth(auth)
			refs, err = remote.List(&options)
		}
	}

	if err != nil {
		return nil, err
	}

	return refs, nil
}

func (r *GitDirectory) Tag(tag string) (*plumbing.Reference, error) {
	repository, err := r.Repository()

	if err != nil {
		return nil, err
	}

	return repository.Tag(tag)
}

func (r *GitDirectory) Branch(branch string) (*plumbing.Reference, error) {
	repository, err := r.Repository()

	if err != nil {
		return nil, err
	}

	branches, err := repository.Branches()

	if err != nil {
		return nil, err
	}

	for {
		b, err := branches.Next()
		if err != nil {
			break
		}
		if b.Name().Short() == branch {
			return b, nil
		}
	}

	return nil, errors.New("cannot find branch")
}

func (r *GitDirectory) GetUrl() (string, error) {
	repository, err := r.Repository()
	if err != nil {
		return "", err
	}

	remote, err := repository.Remote("origin")
	if err != nil {
		return "", err
	}

	return remote.Config().URLs[0], nil
}

type GitRefType = string

const (
	RefCommit GitRefType = "commit"
	RefBranch GitRefType = "branch"
	RefTag    GitRefType = "tag"
)

func (r *GitDirectory) FindRefType(ctx *types.CoreCallContext, ref string) (GitRefType, bool, error) {
	repository, err := r.Repository()

	if err != nil {
		return "", false, err
	}

	branches, err := repository.Branches()

	for {
		branch, err := branches.Next()
		if err != nil {
			break
		}
		if branch.Name().Short() == ref {
			return RefBranch, false, nil
		}
	}

	if err != nil {
		return "", false, err
	}

	tags, err := repository.Tags()

	for {
		tag, err := tags.Next()
		if err != nil {
			break
		}
		if tag.Name().Short() == ref {
			return RefTag, false, nil
		}
	}

	if err != nil {
		return "", false, err
	}

	refsRemote, err := r.LsRemote(ctx, "origin")

	if err != nil {
		return "", false, err
	}

	for _, refRemote := range refsRemote {
		if refRemote.Name().Short() != ref {
			continue
		}

		if refRemote.Name().IsBranch() {
			return RefBranch, true, nil
		} else if refRemote.Name().IsTag() {
			return RefTag, true, nil
		}
	}

	return RefCommit, false, nil
}

// https://github.com/go-git/go-git/blob/main/_examples/checkout-branch/main.go#L66
func (r *GitDirectory) FetchBranch(branchName string, progress *GitStream) error {
	repository, err := r.Repository()

	if err != nil {
		return err
	}

	remote, err := repository.Remote("origin")

	if err != nil {
		return err
	}
	refSpecs := []config.RefSpec{config.RefSpec("refs/heads/" + branchName + ":" + "refs/heads/" + branchName)}

	return remote.Fetch(&git.FetchOptions{
		RefSpecs: refSpecs,
		Progress: progress,
	})
}
