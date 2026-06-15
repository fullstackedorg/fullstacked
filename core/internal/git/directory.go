package git

import (
	"errors"
	"fullstackedorg/fullstacked/types"

	"context"
	"fullstackedorg/fullstacked/internal/tunnel"
	git "github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/config"
	"github.com/go-git/go-git/v6/plumbing"
	"github.com/go-git/go-git/v6/plumbing/client"
	"net"
	nethttp "net/http"
)

type GitDirectory struct {
	Directory  string
	Proxy      string
	repository *git.Repository
	worktree   *git.Worktree
}

func OpenGitDirectory(directory string) (*GitDirectory, error) {
	var repository *git.Repository
	var err error
	if USE_CUSTOM_FS {
		repository, err = CustomOpen(directory)
	} else {
		repository, err = git.PlainOpen(directory)
	}

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

	var repository *git.Repository
	var err error
	if USE_CUSTOM_FS {
		repository, err = CustomOpen(r.Directory)
	} else {
		repository, err = git.PlainOpen(r.Directory)
	}

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

func (r *GitDirectory) getClientOptions(ctx *types.Context, urlStr string, forcePrompt bool) ([]client.Option, error) {
	clientOptions := []client.Option{}

	if r.Proxy != "" {
		t := tunnel.FindTunnel(r.Proxy)
		if t == nil {
			return nil, errors.New("tunnel not found")
		}
		customClient := &nethttp.Client{
			Transport: &nethttp.Transport{
				DialContext: func(netCtx context.Context, network, addr string) (net.Conn, error) {
					return t.Dial(netCtx)
				},
			},
		}
		clientOptions = append(clientOptions, client.WithHTTPClient(customClient))
	}

	auth, err := RequestAuth(ctx, urlStr, forcePrompt)
	if err != nil {
		if forcePrompt {
			return nil, err
		}
	} else {
		clientOptions = append(clientOptions, client.WithHTTPAuth(&HTTPBasicAuth{
			GitAuth: auth,
		}))
	}

	return clientOptions, nil
}

func (r *GitDirectory) LsRemote(ctx *types.Context, remoteName string) ([]*plumbing.Reference, error) {
	urlStr, err := r.GetUrl()

	if err != nil {
		return nil, err
	}

	err = testHost(urlStr, r.Proxy)

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

	clientOpts, err := r.getClientOptions(ctx, urlStr, false)
	if err != nil {
		return nil, err
	}
	options.ClientOptions = clientOpts

	refs, err := remote.List(&options)

	if errIsAuthenticationRequired(err) {
		clientOpts, err = r.getClientOptions(ctx, urlStr, true)
		if err == nil {
			options.ClientOptions = clientOpts
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

func (r *GitDirectory) FindRefType(ctx *types.Context, ref string) (GitRefType, bool, error) {
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

	urlStr, err := r.GetUrl()

	if err != nil {
		return err
	}

	options := git.FetchOptions{
		RefSpecs: refSpecs,
		Progress: progress,
	}

	clientOpts, err := r.getClientOptions(progress.ctx, urlStr, false)
	if err != nil {
		return err
	}
	options.ClientOptions = clientOpts

	err = remote.Fetch(&options)

	if errIsAuthenticationRequired(err) {
		clientOpts, err = r.getClientOptions(progress.ctx, urlStr, true)
		if err == nil {
			options.ClientOptions = clientOpts
			err = remote.Fetch(&options)
		}
	}

	return err
}
