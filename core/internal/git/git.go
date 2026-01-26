package git

import (
	"errors"
	"fullstackedorg/fullstacked/types"

	git "github.com/go-git/go-git/v5"
)

type GitFn = uint8

const (
	Status GitFn = 0
	Add    GitFn = 1
	Log    GitFn = 2
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

	}

	return errors.New("unknown git function")
}

type GitHead struct {
	Branch string
	Hash   string
	Type   string
}

type GitStatus struct {
	Head      GitHead
	Staged    map[string][]string
	Unstaged  map[string][]string
	Untracked []string
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
		Branch: head.Name().String(),
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

		if err != nil {
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
			Message: commit.Message,
		})
	}

	return logs, nil
}
