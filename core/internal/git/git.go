package git

import (
	"encoding/json"
	"errors"
	"fmt"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"io"
	nethttp "net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	git "github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/config"
	"github.com/go-git/go-git/v6/plumbing"
	"github.com/go-git/go-git/v6/plumbing/object"
	"github.com/go-git/go-git/v6/plumbing/storer"
	"github.com/go-git/go-git/v6/plumbing/transport"
	"github.com/go-git/go-git/v6/plumbing/transport/http"
)

type GitFn = uint8

const (
	AuthManager GitFn = 0
	Init        GitFn = 1
	Status      GitFn = 2
	Add         GitFn = 3
	Log         GitFn = 4
	Commit      GitFn = 5
	Clone       GitFn = 6
	Pull        GitFn = 7
	Push        GitFn = 8
	Reset       GitFn = 9
	Branch      GitFn = 10
	Tags        GitFn = 11
	Checkout    GitFn = 12
	Merge       GitFn = 13
	Restore     GitFn = 14
)

type gitAuthManager struct {
	ctx      *types.Context
	streamId uint8
	auths    map[string]GitAuth
	requests map[string]*authRequest
}

type authRequest struct {
	wg   *sync.WaitGroup
	auth *GitAuth
}

// ctx.Id -> gitAuthManager
var gitAuthManagers = make(map[uint8]gitAuthManager)

var ErrNoGitAuthManager = errors.New("no git auth manager found for context")

func getGitAuthManager(ctx *types.Context) (*gitAuthManager, error) {
	gitAuthManager, ok := gitAuthManagers[ctx.Id]
	if !ok {
		return nil, ErrNoGitAuthManager
	}
	return &gitAuthManager, nil
}

func RequestAuth(ctx *types.Context, urlStr string, requestUser bool) (*GitAuth, error) {
	url, err := url.Parse(urlStr)
	if err != nil {
		return nil, err
	}

	gitAuthManager, err := getGitAuthManager(ctx)
	if err != nil {
		return nil, err
	}

	auth := gitAuthManager.auths[url.Host]
	if !requestUser {
		return &auth, nil
	}

	request, ok := gitAuthManager.requests[url.Host]
	if !ok {
		newRequest := authRequest{
			wg: &sync.WaitGroup{},
		}
		newRequest.wg.Add(1)
		request = &newRequest
		gitAuthManager.requests[url.Host] = request
		defer delete(gitAuthManager.requests, url.Host)
		store.StreamEvent(gitAuthManager.ctx, gitAuthManager.streamId, "auth", []types.SerializableData{url.Host}, false)
	}

	request.wg.Wait()

	gitAuthManager.auths[url.Host] = GitAuth{
		Host:     url.Host,
		Username: request.auth.Username,
		Password: request.auth.Password,
		Email:    request.auth.Email,
	}

	return RequestAuth(ctx, urlStr, false)
}

func gitAuthToHttpAuth(gitAuth *GitAuth) *http.BasicAuth {
	if gitAuth == nil {
		return nil
	}

	return &http.BasicAuth{
		Username: gitAuth.Username,
		Password: gitAuth.Password,
	}
}

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case AuthManager:
		response.Type = types.CoreResponseStream

		gitAuthManager := gitAuthManager{
			requests: make(map[string]*authRequest),
			auths:    make(map[string]GitAuth),
		}

		stream := types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				gitAuthManager.ctx = ctx
				gitAuthManager.streamId = streamId
				gitAuthManagers[ctx.Id] = gitAuthManager
			},
			Close: func(ctx *types.Context, streamId uint8) {
				delete(gitAuthManagers, ctx.Id)
			},
			WriteEvent: func(ctx *types.Context, streamId uint8, event string, data []types.DeserializedData) {
				if event != "authResponse" {
					return
				}

				host := data[0].Data.(string)
				request, ok := gitAuthManager.requests[host]
				if !ok {
					return
				}

				gitAuth := GitAuth{}
				if data[1].Type == types.OBJECT {
					json.Unmarshal(data[1].Data.(types.DeserializedRawObject).Data, &gitAuth)
				}
				request.auth = &gitAuth
				request.wg.Done()
			},
		}

		response.Stream = &stream

		return nil
	case Init:
		response.Type = types.CoreResponseData
		return initFn(path.ResolveWithContext(ctx, data[0].Data.(string)), data[1].Data.(string))
	case Status:
		response.Type = types.CoreResponseData

		s, err := status(path.ResolveWithContext(ctx, data[0].Data.(string)))
		if err != nil {
			return err
		}

		response.Data = s
		return nil
	case Add:
		response.Type = types.CoreResponseData
		return add(path.ResolveWithContext(ctx, data[0].Data.(string)), data[1].Data.(string))
	case Log:
		response.Type = types.CoreResponseData
		logs, err := log(path.ResolveWithContext(ctx, data[0].Data.(string)), int(data[1].Data.(float64)))
		if err != nil {
			return err
		}
		response.Data = logs

		return nil
	case Commit:
		response.Type = types.CoreResponseData

		author := GitAuthor{}

		json.Unmarshal(data[2].Data.(types.DeserializedRawObject).Data, &author)

		hash, err := commit(path.ResolveWithContext(ctx, data[0].Data.(string)), data[1].Data.(string), author)
		if err != nil {
			return err
		}
		response.Data = hash

		return nil
	case Clone:
		response.Type = types.CoreResponseStream
		stream, err := clone(
			data[0].Data.(string),
			path.ResolveWithContext(ctx, data[1].Data.(string)),
		)
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	case Pull:
		response.Type = types.CoreResponseStream

		stream, err := pull(path.ResolveWithContext(ctx, data[0].Data.(string)))
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	case Push:
		response.Type = types.CoreResponseStream

		stream, err := push(path.ResolveWithContext(ctx, data[0].Data.(string)))
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	case Reset:
		response.Type = types.CoreResponseData

		files := []string{}
		hard := false
		if len(data) > 1 {
			hard = data[1].Data.(bool)
		}
		if len(data) > 2 {
			for _, f := range data[2:] {
				files = append(files, f.Data.(string))
			}
		}

		return reset(path.ResolveWithContext(ctx, data[0].Data.(string)), hard, files)
	case Branch:
		response.Type = types.CoreResponseStream

		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				branches, err := branch(ctx, path.ResolveWithContext(ctx, data[0].Data.(string)))
				if err != nil {
					return
				}
				jsonBytes, _ := json.Marshal(branches)
				store.StreamChunk(ctx, streamId, jsonBytes, true)
			},
		}

		return nil
	case Tags:
		response.Type = types.CoreResponseStream

		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				tags, err := tags(ctx, path.ResolveWithContext(ctx, data[0].Data.(string)))
				if err != nil {
					return
				}
				jsonBytes, _ := json.Marshal(tags)
				store.StreamChunk(ctx, streamId, jsonBytes, true)
			},
		}

		return nil
	case Checkout:
		response.Type = types.CoreResponseStream
		create := false
		if len(data) > 2 && data[2].Type == types.BOOLEAN {
			create = data[2].Data.(bool)
		}
		stream, err := checkout(
			ctx,
			path.ResolveWithContext(ctx, data[0].Data.(string)),
			data[1].Data.(string),
			create,
		)
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	case Merge:
		response.Type = types.CoreResponseData
		return merge(path.ResolveWithContext(ctx, data[0].Data.(string)), data[1].Data.(string))
	case Restore:
		response.Type = types.CoreResponseData
		files := []string{}
		if len(data) > 1 {
			for _, f := range data[1:] {
				files = append(files, f.Data.(string))
			}
		}
		return restore(path.ResolveWithContext(ctx, data[0].Data.(string)), files)
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

const DateFormat = "Mon Jan 2 15:04:05 2006 -0700"

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
	ctx      *types.Context
	streamId uint8
}

func (progress *GitStream) Write(p []byte) (n int, err error) {
	store.StreamChunk(progress.ctx, progress.streamId, p, false)
	return len(p), nil
}

type GitAuth struct {
	Host     string `json:"host"`
	Username string `json:"username"`
	Password string `json:"password"`
	Email    string `json:"email"`
}

func clone(
	urlStr string,
	directory string,
) (*types.ResponseStream, error) {
	err := testHost(urlStr)

	if err != nil {
		return nil, err
	}

	url, err := url.Parse(urlStr)

	if err != nil {
		return nil, err
	}

	exists := fs.ExistsFn(directory)

	if exists {
		directory = filepath.Join(directory, strings.TrimSuffix(filepath.Base(url.Path), ".git"))
		exists = fs.ExistsFn(directory)
	}

	processErr := func(ctx *types.Context, streamId uint8, err error, print bool) {
		if err == nil {
			return
		}

		if !exists && err != transport.ErrEmptyRemoteRepository {
			fs.RmFn(directory)
		}

		if print {
			store.StreamChunk(ctx, streamId, []byte(err.Error()+"\n"), false)
		}
	}

	return &types.ResponseStream{
		Open: func(ctx *types.Context, streamId uint8) {

			gitAuth, _ := RequestAuth(ctx, urlStr, false)
			// run once
			options := git.CloneOptions{
				URL:  urlStr,
				Auth: gitAuthToHttpAuth(gitAuth),
				Progress: &GitStream{
					ctx:      ctx,
					streamId: streamId,
				},
			}

			_, err := git.PlainClone(directory, &options)

			if err != nil {
				processErr(ctx, streamId, err, false)

				if errIsAuthenticationRequired(err) {
					// retry with new auth
					gitAuth, err = RequestAuth(ctx, urlStr, true)
					if err == nil {
						options.Auth = gitAuthToHttpAuth(gitAuth)
						_, err = git.PlainClone(directory, &options)
					}
				}

				processErr(ctx, streamId, err, true)
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

	urlStr, err := dir.GetUrl()

	if err != nil {
		return nil, err
	}

	err = testHost(urlStr)

	if err != nil {
		return nil, err
	}

	repository, err := dir.Repository()

	if err != nil {
		return nil, err
	}

	head, err := repository.Head()

	if err != nil {
		return nil, err
	}

	worktree, err := dir.Worktree()

	if err != nil {
		return nil, err
	}
	return &types.ResponseStream{
		Open: func(ctx *types.Context, streamId uint8) {

			options := git.PullOptions{
				Progress: &GitStream{
					ctx:      ctx,
					streamId: streamId,
				},
				RemoteName:    "origin",
				ReferenceName: head.Name(),
			}

			auth, _ := RequestAuth(ctx, urlStr, false)
			options.Auth = gitAuthToHttpAuth(auth)

			err = worktree.Pull(&options)

			if errIsAuthenticationRequired(err) {
				auth, err = RequestAuth(ctx, urlStr, true)
				if err == nil {
					options.Auth = gitAuthToHttpAuth(auth)
					err = worktree.Pull(&options)
				}
			}

			if err != nil {
				store.StreamChunk(ctx, streamId, []byte(err.Error()+"\n"), false)
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

	urlStr, err := dir.GetUrl()

	if err != nil {
		return nil, err
	}

	err = testHost(urlStr)

	if err != nil {
		return nil, err
	}

	repository, err := dir.Repository()

	if err != nil {
		return nil, err
	}

	return &types.ResponseStream{
		Open: func(ctx *types.Context, streamId uint8) {
			options := git.PushOptions{
				Progress: &GitStream{
					ctx:      ctx,
					streamId: streamId,
				},
			}

			auth, _ := RequestAuth(ctx, urlStr, false)
			options.Auth = gitAuthToHttpAuth(auth)

			err := repository.Push(&options)

			if errIsAuthenticationRequired(err) {
				auth, err = RequestAuth(ctx, urlStr, true)
				if err == nil {
					options.Auth = gitAuthToHttpAuth(auth)
					err = repository.Push(&options)
				}
			}

			if err != nil {
				store.StreamChunk(ctx, streamId, []byte(err.Error()+"\n"), false)
			}

			store.StreamChunk(ctx, streamId, nil, true)
		},
	}, nil
}

func reset(directory string, hard bool, files []string) error {
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

	mode := git.MixedReset
	if hard {
		mode = git.HardReset
	}

	return worktree.Reset(&git.ResetOptions{
		Files: files,
		Mode:  mode,
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

func branch(ctx *types.Context, directory string) ([]GitBranch, error) {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return nil, err
	}

	refsRemote, err := dir.LsRemote(ctx, "origin")

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

func tags(ctx *types.Context, directory string) ([]GitTag, error) {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return nil, err
	}

	refsRemote, err := dir.LsRemote(ctx, "origin")

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

func checkout(ctx *types.Context, directory string, ref string, create bool) (*types.ResponseStream, error) {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return nil, err
	}

	refType, remote, err := dir.FindRefType(ctx, ref)

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
		Open: func(ctx *types.Context, streamId uint8) {
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

func errIsAuthenticationRequired(err error) bool {
	if err == nil {
		return false
	}
	return strings.HasPrefix(err.Error(), transport.ErrAuthenticationRequired.Error())
}

func testHost(urlStr string) error {
	u, err := url.Parse(urlStr)
	if err != nil {
		return err
	}

	client := nethttp.Client{
		Timeout: 5 * time.Second,
	}

	resp, err := client.Head(fmt.Sprintf("%s://%s", u.Scheme, u.Host))
	if err != nil {
		return err
	}

	return resp.Body.Close()
}

func restore(directory string, paths []string) error {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return err
	}

	worktree, err := dir.Worktree()

	if err != nil {
		return err
	}

	return worktree.Restore(&git.RestoreOptions{
		Staged:   true,
		Worktree: true,
		Files:    paths,
	})
}
