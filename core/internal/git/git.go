package git

import (
	"errors"
	"fmt"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"io"
	"net/url"
	"path"
	"strings"
	"time"

	git "github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/config"
	"github.com/go-git/go-git/v6/plumbing"
	"github.com/go-git/go-git/v6/plumbing/object"
	"github.com/go-git/go-git/v6/plumbing/storer"
	"github.com/go-git/go-git/v6/plumbing/transport"
)

type GitFn = uint8

const (
	Init     GitFn = 0
	Status   GitFn = 1
	Add      GitFn = 2
	Log      GitFn = 3
	Commit   GitFn = 4
	Clone    GitFn = 5
	Pull     GitFn = 6
	Push     GitFn = 7
	Reset    GitFn = 8
	Branch   GitFn = 9
	Tags     GitFn = 10
	Checkout GitFn = 11
	Merge    GitFn = 12
)

func directory(ctx *types.CoreCallContext, data types.DeserializedData) string {
	if data.Type == types.UNDEFINED {
		return ctx.BaseDirectory
	}

	return data.Data.(string)
}

func Switch(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Init:
		response.Type = types.CoreResponseData
		return initFn(directory(ctx, data[0]), data[1].Data.(string))
	case Status:
		response.Type = types.CoreResponseData

		s, err := status(directory(ctx, data[0]))
		if err != nil {
			return err
		}

		response.Data = s
		return nil
	case Add:
		response.Type = types.CoreResponseData
		return add(directory(ctx, data[0]), data[1].Data.(string))
	case Log:
		response.Type = types.CoreResponseData
		logs, err := log(directory(ctx, data[0]), int(data[1].Data.(float64)))
		if err != nil {
			return err
		}
		response.Data = logs

		return nil
	case Commit:
		response.Type = types.CoreResponseData

		author := GitAuthor{
			Name:  data[2].Data.(string),
			Email: data[3].Data.(string),
		}

		hash, err := commit(directory(ctx, data[0]), data[1].Data.(string), author)
		if err != nil {
			return err
		}
		response.Data = hash

		return nil
	case Clone:
		response.Type = types.CoreResponseStream

		directory := "."
		if data[1].Type == types.STRING {
			directory = data[1].Data.(string)
		}

		stream, err := clone(data[0].Data.(string), directory)
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	case Pull:
		response.Type = types.CoreResponseStream

		stream, err := pull(directory(ctx, data[0]))
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	case Push:
		response.Type = types.CoreResponseStream

		stream, err := push(directory(ctx, data[0]))
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	case Reset:
		response.Type = types.CoreResponseData

		files := []string{}
		if len(data) > 1 {
			for _, f := range data[1:] {
				files = append(files, f.Data.(string))
			}
		}

		return reset(directory(ctx, data[0]), files)
	case Branch:
		response.Type = types.CoreResponseData

		branches, err := branch(directory(ctx, data[0]))
		if err != nil {
			return err
		}
		response.Data = branches

		return nil
	case Tags:
		response.Type = types.CoreResponseData

		tags, err := tags(directory(ctx, data[0]))
		if err != nil {
			return err
		}
		response.Data = tags

		return nil
	case Checkout:
		response.Type = types.CoreResponseStream
		create := false
		if len(data) > 2 && data[2].Type == types.BOOLEAN {
			create = data[2].Data.(bool)
		}
		stream, err := checkout(directory(ctx, data[0]), data[1].Data.(string), create)
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	case Merge:
		response.Type = types.CoreResponseData
		return merge(directory(ctx, data[0]), data[1].Data.(string))
	}

	return errors.New("unknown git function")
}

func initFn(directory string, url string) error {
	repository, err := git.PlainInit(directory, false, git.WithDefaultBranch(plumbing.Main))

	if err != nil {
		return err
	}

	_, err = repository.CreateRemote(&config.RemoteConfig{
		Name: "origin",
		URLs: []string{url},
	})

	return err
}

type GitHead struct {
	Branch string `json:"branch"`
	Hash   string `json:"hash"`
	Type   string `json:"type"`
}

type GitStatus struct {
	Head      GitHead             `json:"head"`
	Staged    map[string][]string `json:"staged"`
	Unstaged  map[string][]string `json:"unstaged"`
	Untracked []string            `json:"untracked"`
}

func statusCodeToString(statusCode git.StatusCode) string {
	switch statusCode {
	case git.Added:
		return "added"
	case git.Deleted:
		return "deleted"
	case git.Modified:
		return "modified"
	case git.Copied:
		return "copied"
	case git.Renamed:
		return "renamed"
	case git.Unmodified:
		return "unmodified"
	case git.Untracked:
		return "untracked"
	case git.UpdatedButUnmerged:
		return "unmerged"
	}

	return "unknown"
}

func status(directory string) (GitStatus, error) {
	s := GitStatus{
		Staged:    map[string][]string{},
		Unstaged:  map[string][]string{},
		Untracked: []string{},
	}

	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return s, err
	}

	repository, err := dir.Repository()

	if err != nil {
		return s, err
	}

	head, err := repository.Head()

	if err != nil {
		return s, err
	}

	s.Head = GitHead{
		Branch: head.Name().Short(),
		Hash:   head.Hash().String(),
		Type:   head.Type().String(),
	}

	worktree, err := repository.Worktree()

	if err != nil {
		return s, err
	}

	changes, err := worktree.Status()

	if err != nil {
		return s, err
	}

	for file, fileStatus := range changes {
		if fileStatus.Worktree == git.Untracked {
			s.Untracked = append(s.Untracked, file)
			continue
		}

		if fileStatus.Staging == git.Unmodified {
			fileStatusStr := statusCodeToString(fileStatus.Worktree)
			_, ok := s.Unstaged[fileStatusStr]
			if !ok {
				s.Unstaged[fileStatusStr] = []string{}
			}
			s.Unstaged[fileStatusStr] = append(s.Unstaged[fileStatusStr], file)
		} else {
			fileStatusStr := statusCodeToString(fileStatus.Staging)
			_, ok := s.Staged[fileStatusStr]
			if !ok {
				s.Staged[fileStatusStr] = []string{}
			}
			s.Staged[fileStatusStr] = append(s.Staged[fileStatusStr], file)
		}
	}

	return s, nil
}

func add(directory string, path string) error {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return err
	}

	repository, err := dir.Repository()

	if err != nil {
		return err
	}

	worktree, err := repository.Worktree()

	if err != nil {
		return err
	}

	if path == "." {
		err = worktree.AddWithOptions(&git.AddOptions{
			All: true,
		})
	} else {

		_, err = worktree.Add(path)
	}

	return err
}

type GitAuthor struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

type GitCommit struct {
	Hash    string    `json:"hash"`
	Author  GitAuthor `json:"author"`
	Date    string    `json:"date"`
	Message string    `json:"message"`
}

const DateFormat = "Mon Jan 02 15:04:05 2006 -0700"

func log(directory string, n int) ([]GitCommit, error) {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return nil, err
	}

	repository, err := dir.Repository()

	if err != nil {
		return nil, err
	}

	opts := git.LogOptions{}

	iter, err := repository.Log(&opts)

	if err != nil {
		return nil, err
	}

	logs := []GitCommit{}
	for n > len(logs) {
		commit, err := iter.Next()

		if err == io.EOF {
			break
		} else if err != nil {
			return nil, err
		}

		logs = append(logs, GitCommit{
			Hash: commit.Hash.String(),
			Author: GitAuthor{
				Name:  commit.Author.Name,
				Email: commit.Author.Email,
			},
			Date:    commit.Author.When.Format(DateFormat),
			Message: strings.TrimSpace(commit.Message),
		})
	}

	return logs, nil
}

func commit(directory string, message string, author GitAuthor) (string, error) {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return "", err
	}

	repository, err := dir.Repository()

	if err != nil {
		return "", err
	}

	worktree, err := repository.Worktree()

	if err != nil {
		return "", err
	}

	hash, err := worktree.Commit(message, &git.CommitOptions{
		Author: &object.Signature{
			Name:  author.Name,
			Email: author.Email,
			When:  time.Now(),
		},
	})

	if err != nil {
		return "", err
	}

	return hash.String(), nil
}

type GitStream struct {
	ctx      *types.CoreCallContext
	streamId uint8
}

func (progress *GitStream) Write(p []byte) (n int, err error) {
	store.StreamChunk(progress.ctx, progress.streamId, p, false)
	return len(p), nil
}

func clone(urlStr string, directory string) (*types.ResponseStream, error) {
	url, err := url.Parse(urlStr)

	if err != nil {
		return nil, err
	}

	if directory == "." {
		directory = strings.TrimSuffix(path.Base(url.Path), path.Ext(url.Path))
	}

	return &types.ResponseStream{
		Open: func(ctx *types.CoreCallContext, streamId uint8) {
			_, err := git.PlainClone(directory, &git.CloneOptions{
				URL: urlStr,
				Progress: &GitStream{
					ctx:      ctx,
					streamId: streamId,
				},
			})

			if err == transport.ErrEmptyRemoteRepository {
				store.StreamChunk(ctx, streamId, []byte(err.Error()), false)
			} else if err != nil {
				fmt.Println(err)
			}

			store.StreamChunk(ctx, streamId, nil, true)
		},
	}, nil
}

func pull(directory string) (*types.ResponseStream, error) {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return nil, err
	}

	repository, err := dir.Repository()

	if err != nil {
		return nil, err
	}

	worktree, err := repository.Worktree()

	if err != nil {
		return nil, err
	}

	return &types.ResponseStream{
		Open: func(ctx *types.CoreCallContext, streamId uint8) {
			progress := GitStream{
				ctx:      ctx,
				streamId: streamId,
			}

			err = worktree.Pull(&git.PullOptions{
				Progress: &progress,
			})

			if err != nil {
				fmt.Println(err)
			}

			store.StreamChunk(ctx, streamId, nil, true)
		},
	}, nil
}

func push(directory string) (*types.ResponseStream, error) {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return nil, err
	}

	repository, err := dir.Repository()

	if err != nil {
		return nil, err
	}

	return &types.ResponseStream{
		Open: func(ctx *types.CoreCallContext, streamId uint8) {
			err := repository.Push(&git.PushOptions{
				Progress: &GitStream{
					ctx:      ctx,
					streamId: streamId,
				},
			})

			if err != nil {
				fmt.Println(err)
			}

			store.StreamChunk(ctx, streamId, nil, true)
		},
	}, nil
}

func reset(directory string, files []string) error {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return err
	}

	repository, err := dir.Repository()

	if err != nil {
		return err
	}

	worktree, err := repository.Worktree()

	if err != nil {
		return err
	}

	return worktree.Reset(&git.ResetOptions{
		Files: files,
	})
}

type GitBranch struct {
	Name   string `json:"name"`
	Remote bool   `json:"remote"`
	Local  bool   `json:"local"`
}

func refIteratorToReferenceSlice(iter storer.ReferenceIter) []*plumbing.Reference {
	refs := []*plumbing.Reference{}
	iter.ForEach(func(r *plumbing.Reference) error {
		refs = append(refs, r)
		return nil
	})

	return refs
}

func branch(directory string) ([]GitBranch, error) {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return nil, err
	}

	refsRemote, err := dir.LsRemote("origin")

	if err != nil {
		return nil, err
	}

	repository, err := dir.Repository()

	if err != nil {
		return nil, err
	}

	branchIter, err := repository.Branches()

	if err != nil {
		return nil, err
	}

	refsLocal := refIteratorToReferenceSlice(branchIter)

	branches := []GitBranch{}
	mergeBranches := func(refs []*plumbing.Reference, remote bool) {
		for _, ref := range refs {
			if !ref.Name().IsBranch() {
				continue
			}

			index := -1
			for i, b := range branches {
				if b.Name == ref.Name().Short() {
					index = i
					break
				}
			}

			if index == -1 {
				index = len(branches)
				branches = append(branches, GitBranch{
					Name: ref.Name().Short(),
				})
			}

			if remote {
				branches[index].Remote = true
			} else {
				branches[index].Local = true
			}
		}
	}
	mergeBranches(refsRemote, true)
	mergeBranches(refsLocal, false)

	return branches, nil
}

type GitTag struct {
	Name   string `json:"name"`
	Hash   string `json:"hash"`
	Remote bool   `json:"remote"`
	Local  bool   `json:"local"`
}

func tags(directory string) ([]GitTag, error) {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return nil, err
	}

	refsRemote, err := dir.LsRemote("origin")

	if err != nil {
		return nil, err
	}

	repository, err := dir.Repository()

	if err != nil {
		return nil, err
	}

	tagsIter, err := repository.Tags()

	if err != nil {
		return nil, err
	}

	refsLocal := refIteratorToReferenceSlice(tagsIter)

	tags := []GitTag{}
	mergeTags := func(refs []*plumbing.Reference, remote bool) {
		for _, ref := range refs {
			if !ref.Name().IsTag() {
				continue
			}

			index := -1
			for i, b := range tags {
				if b.Name == ref.Name().Short() {
					index = i
					break
				}
			}

			if index == -1 {
				index = len(tags)
				tags = append(tags, GitTag{
					Name: ref.Name().Short(),
					Hash: ref.Hash().String(),
				})
			}

			if remote {
				tags[index].Remote = true
			} else {
				tags[index].Local = true
			}
		}
	}
	mergeTags(refsRemote, true)
	mergeTags(refsLocal, false)

	return tags, nil
}

func checkout(directory string, ref string, create bool) (*types.ResponseStream, error) {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return nil, err
	}

	refType, remote, err := dir.FindRefType(ref)

	if err != nil {
		return nil, err
	}

	if create {
		refType = RefBranch
	}

	repository, err := dir.Repository()

	if err != nil {
		return nil, err
	}

	worktree, err := repository.Worktree()

	if err != nil {
		return nil, err
	}

	return &types.ResponseStream{
		Open: func(ctx *types.CoreCallContext, streamId uint8) {
			switch refType {
			case RefCommit:
				err = worktree.Checkout(&git.CheckoutOptions{
					Hash: plumbing.NewHash(ref),
				})
			case RefTag:
				tag, err := dir.Tag(ref)
				if err != nil {
					fmt.Println(err)
				}
				err = worktree.Checkout(&git.CheckoutOptions{
					Hash: tag.Hash(),
				})
			case RefBranch:
				if remote {
					err = dir.FetchBranch(ref, &GitStream{
						ctx:      ctx,
						streamId: streamId,
					})
				}

				if err != nil {
					fmt.Println(err)
				}

				err = worktree.Checkout(&git.CheckoutOptions{
					Branch: plumbing.NewBranchReferenceName(ref),
					Create: create,
				})
				if err != nil {
					fmt.Println(err)
				}
			}

			store.StreamChunk(ctx, streamId, nil, true)
		},
	}, nil
}

func merge(directory string, branchName string) error {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return err
	}

	branch, err := dir.Branch(branchName)

	if err != nil {
		return err
	}

	repository, err := dir.Repository()

	if err != nil {
		return err
	}

	err = repository.Merge(*branch, git.MergeOptions{})

	if err != nil {
		return err
	}

	worktree, err := dir.Worktree()

	if err != nil {
		return err
	}

	return worktree.Reset(&git.ResetOptions{
		Mode: git.HardReset,
	})
}
