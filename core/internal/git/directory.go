package git

import (
	git "github.com/go-git/go-git/v6"
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

func (r *GitDirectory) LsRemote(remoteName string) ([]*plumbing.Reference, error) {
	repository, err := r.Repository()

	if err != nil {
		return nil, err
	}

	remote, err := repository.Remote(remoteName)

	if err != nil {
		return nil, err
	}

	refs, err := remote.List(&git.ListOptions{})

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

type GitRefType = string

const (
	RefCommit GitRefType = "commit"
	RefBranch GitRefType = "branch"
	RefTag    GitRefType = "tag"
)

func (r *GitDirectory) FindRefType(ref string) (GitRefType, error) {
	repository, err := r.Repository()

	if err != nil {
		return "", err
	}

	branches, err := repository.Branches()

	for {
		branch, err := branches.Next()
		if err != nil {
			break
		}
		if branch.Name().Short() == ref {
			return RefBranch, nil
		}
	}

	if err != nil {
		return "", err
	}

	tags, err := repository.Tags()

	for {
		tag, err := tags.Next()
		if err != nil {
			break
		}
		if tag.Name().Short() == ref {
			return RefTag, nil
		}
	}

	if err != nil {
		return "", err
	}

	return RefCommit, nil
}
