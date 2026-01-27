package git

import (
	"encoding/json"
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
	"github.com/go-git/go-git/v6/plumbing/object"
	"github.com/go-git/go-git/v6/plumbing/transport"
)

type GitFn = uint8

const (
	Status GitFn = 0
	Add    GitFn = 1
	Log    GitFn = 2
	Commit GitFn = 3
	Clone  GitFn = 4
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

		err := add(directory(ctx, data[0]), data[1].Data.(string))
		if err != nil {
			return err
		}

		return nil
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

		author := GitAuthor{}
		json.Unmarshal(data[2].Data.(types.DeserializedRawObject).Data, &author)

		err := commit(directory(ctx, data[0]), data[1].Data.(string), author)
		if err != nil {
			return err
		}

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
	}

	return errors.New("unknown git function")
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

	repository, err := git.PlainOpen(directory)

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
	repository, err := git.PlainOpen(directory)

	if err != nil {
		return err
	}

	worktree, err := repository.Worktree()

	if err != nil {
		return err
	}

	_, err = worktree.Add(path)

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
	repository, err := git.PlainOpen(directory)

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
		commit.String()

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

func commit(directory string, message string, author GitAuthor) error {
	repository, err := git.PlainOpen(directory)

	if err != nil {
		return err
	}

	worktree, err := repository.Worktree()

	if err != nil {
		return err
	}

	_, err = worktree.Commit(message, &git.CommitOptions{
		Author: &object.Signature{
			Name:  author.Name,
			Email: author.Email,
			When:  time.Now(),
		},
	})

	return err
}

type GitCloneStream struct {
	ctx      *types.CoreCallContext
	streamId uint8
}

func (progress *GitCloneStream) Write(p []byte) (n int, err error) {
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
				Progress: &GitCloneStream{
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
