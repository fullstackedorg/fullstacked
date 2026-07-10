package git

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/internal/path"
	"fullstackedorg/fullstacked/internal/plugin"
	"fullstackedorg/fullstacked/internal/store"
	tunnelPkg "fullstackedorg/fullstacked/internal/tunnel"
	"fullstackedorg/fullstacked/types"
	"io"
	"net"
	nethttp "net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	git "github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/config"
	"github.com/go-git/go-git/v6/plumbing"
	formatconfig "github.com/go-git/go-git/v6/plumbing/format/config"
	"github.com/go-git/go-git/v6/plumbing/object"
	"github.com/go-git/go-git/v6/plumbing/storer"
	"github.com/go-git/go-git/v6/plumbing/transport"
)

type GitFn = uint8

const (
	HasGit    GitFn = 0
	Init      GitFn = 1
	Head      GitFn = 2
	Status    GitFn = 3
	Add       GitFn = 4
	Log       GitFn = 5
	Commit    GitFn = 6
	Clone     GitFn = 7
	Pull      GitFn = 8
	Push      GitFn = 9
	Reset     GitFn = 10
	Branch    GitFn = 11
	Tags      GitFn = 12
	Checkout  GitFn = 13
	Merge     GitFn = 14
	Restore   GitFn = 15
	SetConfig GitFn = 16
)

// 2026-06-15
// USE_CUSTOM_FS toggles the use of our custom filesystem wrapper (fs.go).
// When true, we avoid using go-git's Plain* methods which utilize os.Root
// under the hood (via go-billy's osfs). On macOS sandboxed environments,
// os.Root operations like fs.root.Stat can return permission denied
// instead of ErrNotExist, causing failures during git operations.
var USE_CUSTOM_FS = true

func RequestAuth(ctx *types.Context, urlStr string, requestUser bool) (*types.GitAuth, error) {
	url, err := url.Parse(urlStr)
	if err != nil {
		return nil, err
	}

	if ctx.GitAuthsMutex == nil {
		ctx.GitAuthsMutex = &sync.Mutex{}
	}
	ctx.GitAuthsMutex.Lock()
	if ctx.GitAuths == nil {
		ctx.GitAuths = make(map[string]*types.GitAuth)
	}
	ctx.GitAuthsMutex.Unlock()

	ctx.GitAuthsMutex.Lock()
	auth := ctx.GitAuths[url.Host]
	ctx.GitAuthsMutex.Unlock()

	if !requestUser {
		return auth, nil
	}

	if ctx.PluginsMutex == nil {
		ctx.PluginsMutex = &sync.Mutex{}
	}
	ctx.PluginsMutex.Lock()
	if ctx.Plugins == nil {
		ctx.Plugins = make(map[uint8]*types.ContextPlugin)
	}
	ctx.PluginsMutex.Unlock()

	gitAuthPlugins := plugin.GetPluginsOfTypes(ctx, types.PluginTypeGitAuth)
	if len(gitAuthPlugins) == 0 {
		return nil, errors.New("no git auth plugins")
	}

	if len(gitAuthPlugins) > 1 {
		return nil, errors.New("not supporting multiple git auth plugins currently")
	}

	response, err := plugin.Call(ctx, gitAuthPlugins[0].Id, []types.SerializableData{url.Host})
	if err != nil {
		return nil, err
	}

	if len(response) == 0 || response[0].Type != types.OBJECT {
		return nil, errors.New("git auth plugin responded wrong data type")
	}

	gitAuth := types.GitAuth{}

	err = json.Unmarshal(response[0].Data.(types.DeserializedRawObject).Data, &gitAuth)
	if err != nil {
		return nil, err
	}

	ctx.GitAuthsMutex.Lock()
	ctx.GitAuths[url.Host] = &gitAuth
	ctx.GitAuthsMutex.Unlock()

	return &gitAuth, nil
}

type HTTPBasicAuth struct {
	GitAuth *types.GitAuth
}

func (a *HTTPBasicAuth) Authorizer(r *nethttp.Request) error {
	if a.GitAuth != nil && (a.GitAuth.Username != "" || a.GitAuth.Password != "") {
		r.SetBasicAuth(a.GitAuth.Username, a.GitAuth.Password)
	}

	return nil
}

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case HasGit:
		response.Type = types.CoreResponseData
		response.Data = HasGitFn(path.ResolveWithContext(ctx, data[0].Data.(string)))
		return nil
	case Init:
		response.Type = types.CoreResponseData
		return initFn(path.ResolveWithContext(ctx, data[0].Data.(string)), data[1].Data.(string))
	case Head:
		response.Type = types.CoreResponseData
		head, err := HeadFn(path.ResolveWithContext(ctx, data[0].Data.(string)))
		if err != nil {
			return err
		}
		response.Data = head
		return nil
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
		tunnel := ""
		proxy := (*GitProxy)(nil)
		if len(data) > 2 && data[2].Type == types.STRING {
			tunnel = data[2].Data.(string)
		}
		if len(data) > 3 && data[3].Type == types.OBJECT {
			proxy = &GitProxy{}
			json.Unmarshal(data[3].Data.(types.DeserializedRawObject).Data, proxy)
		}

		stream, err := clone(
			data[0].Data.(string),
			path.ResolveWithContext(ctx, data[1].Data.(string)),
			tunnel,
			proxy,
		)
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	case Pull:
		response.Type = types.CoreResponseStream
		tunnel := ""
		if len(data) > 1 && data[1].Type == types.STRING {
			tunnel = data[1].Data.(string)
		}
		stream, err := pull(path.ResolveWithContext(ctx, data[0].Data.(string)), tunnel)
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	case Push:
		response.Type = types.CoreResponseStream
		tunnel := ""
		if len(data) > 1 && data[1].Type == types.STRING {
			tunnel = data[1].Data.(string)
		}
		stream, err := push(path.ResolveWithContext(ctx, data[0].Data.(string)), tunnel)
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
		tunnel := ""
		if len(data) > 3 && data[3].Type == types.STRING {
			tunnel = data[3].Data.(string)
		}
		stream, err := checkout(
			path.ResolveWithContext(ctx, data[0].Data.(string)),
			data[1].Data.(string),
			create,
			tunnel,
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
	case SetConfig:
		response.Type = types.CoreResponseData
		return setConfig(
			path.ResolveWithContext(ctx, data[0].Data.(string)),
			data[1].Data.(string),
			data[2].Data.(string),
		)
	}

	return errors.New("unknown git function")
}

func HasGitFn(directory string) bool {
	dir, err := OpenGitDirectory(directory)
	if err != nil {
		return false
	}
	_ = dir.Close()
	return true
}

func initFn(directory string, url string) error {
	var repository *git.Repository
	var err error
	if USE_CUSTOM_FS {
		repository, err = CustomInit(directory, false, git.WithDefaultBranch(plumbing.Main))
	} else {
		repository, err = git.PlainInit(directory, false, git.WithDefaultBranch(plumbing.Main))
	}

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

func HeadFn(directory string) (GitHead, error) {
	dir, err := OpenGitDirectory(directory)
	if err != nil {
		return GitHead{}, err
	}
	defer dir.Close()

	repository, err := dir.Repository()
	if err != nil {
		return GitHead{}, err
	}

	head, err := repository.Head()
	if err != nil {
		return GitHead{}, err
	}

	return GitHead{
		Branch: head.Name().Short(),
		Hash:   head.Hash().String(),
		Type:   head.Type().String(),
	}, nil
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
	defer dir.Close()

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
	defer dir.Close()

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
	defer dir.Close()

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
	defer dir.Close()

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

type GitProxy struct {
	Url     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

func clone(
	urlStr string,
	directory string,
	tunnel string,
	proxy *GitProxy,
) (*types.ResponseStream, error) {
	err := testHost(urlStr, tunnel, "", proxy)

	if err != nil {
		return nil, err
	}

	tempDir := &GitDirectory{Tunnel: tunnel, Proxy: proxy}

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

			options := git.CloneOptions{
				AllowEmptyRepo: true,
				URL:            urlStr,
				Progress: &GitStream{
					ctx:      ctx,
					streamId: streamId,
				},
			}

			clientOpts, err := tempDir.getClientOptions(ctx, urlStr, false)
			if err == nil {
				options.ClientOptions = clientOpts
			}

			var cloneErr error
			var r *git.Repository
			if USE_CUSTOM_FS {
				r, cloneErr = CustomCloneContext(context.Background(), directory, &options)
			} else {
				r, cloneErr = git.PlainClone(directory, &options)
			}
			if cloneErr == nil && r != nil {
				saveProxyConfig(r, proxy)
			}
			if r != nil {
				_ = r.Close()
			}

			if cloneErr != nil {
				processErr(ctx, streamId, cloneErr, false)

				if errIsAuthenticationRequired(cloneErr) {
					clientOpts, err = tempDir.getClientOptions(ctx, urlStr, true)
					if err == nil {
						options.ClientOptions = clientOpts
						if USE_CUSTOM_FS {
							r, cloneErr = CustomCloneContext(context.Background(), directory, &options)
						} else {
							r, cloneErr = git.PlainClone(directory, &options)
						}
						if cloneErr == nil && r != nil {
							saveProxyConfig(r, proxy)
						}
						if r != nil {
							_ = r.Close()
						}
					}
				}

				if errIsAuthenticationRequired(cloneErr) {
					invalidateAuth(ctx, urlStr)
				}
				processErr(ctx, streamId, cloneErr, true)
			}

			store.StreamChunk(ctx, streamId, nil, true)
		},
	}, nil
}

func saveProxyConfig(r *git.Repository, proxy *GitProxy) {
	if proxy == nil {
		return
	}
	cfg, err := r.Config()
	if err != nil {
		return
	}
	if cfg.Raw == nil {
		cfg.Raw = formatconfig.New()
	}
	if proxy.Url != "" {
		cfg.Raw.SetOption("http", "", "proxy", proxy.Url)
	}
	if len(proxy.Headers) > 0 {
		sec := cfg.Raw.Section("http")
		if sec != nil {
			sec.RemoveOption("extraHeader")
		}
		for k, v := range proxy.Headers {
			cfg.Raw.AddOption("http", "", "extraHeader", fmt.Sprintf("%s: %s", k, v))
		}
	}
	_ = r.SetConfig(cfg)
}

func CloneRepo(ctx *types.Context, urlStr string, directory string, progress io.Writer) error {
	err := testHost(urlStr, "", "", nil)

	if err != nil {
		return err
	}

	exists := fs.ExistsFn(directory)

	processErr := func(err error) {
		if err == nil {
			return
		}

		if !exists && err != transport.ErrEmptyRemoteRepository {
			fs.RmFn(directory)
		}
	}

	// run once
	options := git.CloneOptions{
		URL:      urlStr,
		Progress: progress,
	}

	tempDir := &GitDirectory{}
	clientOpts, err := tempDir.getClientOptions(ctx, urlStr, false)
	if err == nil {
		options.ClientOptions = clientOpts
	}

	var cloneErr error
	var r *git.Repository
	if USE_CUSTOM_FS {
		r, cloneErr = CustomCloneContext(context.Background(), directory, &options)
	} else {
		r, cloneErr = git.PlainClone(directory, &options)
	}
	if r != nil {
		_ = r.Close()
	}

	if cloneErr != nil {
		processErr(cloneErr)

		if errIsAuthenticationRequired(cloneErr) {
			clientOpts, err = tempDir.getClientOptions(ctx, urlStr, true)
			if err == nil {
				options.ClientOptions = clientOpts
				if USE_CUSTOM_FS {
					r, cloneErr = CustomCloneContext(context.Background(), directory, &options)
				} else {
					r, cloneErr = git.PlainClone(directory, &options)
				}
				if r != nil {
					_ = r.Close()
				}
			}
		}

		if errIsAuthenticationRequired(cloneErr) {
			invalidateAuth(ctx, urlStr)
		}
		processErr(cloneErr)
	}

	return err
}

func pull(directory string, tunnel string) (*types.ResponseStream, error) {
	dir, err := OpenGitDirectory(directory)
	if err == nil {
		dir.Tunnel = tunnel
	}

	if err != nil {
		return nil, err
	}

	urlStr, err := dir.GetUrl()

	if err != nil {
		_ = dir.Close()
		return nil, err
	}

	err = testHost(urlStr, tunnel, directory, nil)

	if err != nil {
		_ = dir.Close()
		return nil, err
	}

	repository, err := dir.Repository()

	if err != nil {
		_ = dir.Close()
		return nil, err
	}

	head, err := repository.Head()

	if err != nil {
		_ = dir.Close()
		return nil, err
	}

	worktree, err := dir.Worktree()

	if err != nil {
		_ = dir.Close()
		return nil, err
	}
	return &types.ResponseStream{
		Open: func(ctx *types.Context, streamId uint8) {
			defer dir.Close()

			options := git.PullOptions{
				Progress: &GitStream{
					ctx:      ctx,
					streamId: streamId,
				},
				RemoteName:    "origin",
				ReferenceName: head.Name(),
			}

			clientOpts, err := dir.getClientOptions(ctx, urlStr, false)
			if err == nil {
				options.ClientOptions = clientOpts
			}

			err = worktree.Pull(&options)

			if errIsAuthenticationRequired(err) {
				clientOpts, err = dir.getClientOptions(ctx, urlStr, true)
				if err == nil {
					options.ClientOptions = clientOpts
					err = worktree.Pull(&options)
				}
			}

			if errIsAuthenticationRequired(err) {
				invalidateAuth(ctx, urlStr)
			}

			if err != nil {
				store.StreamChunk(ctx, streamId, []byte(err.Error()+"\n"), false)
			}

			store.StreamChunk(ctx, streamId, nil, true)
		},
	}, nil
}

func push(directory string, tunnel string) (*types.ResponseStream, error) {
	dir, err := OpenGitDirectory(directory)
	if err == nil {
		dir.Tunnel = tunnel
	}

	if err != nil {
		return nil, err
	}

	urlStr, err := dir.GetUrl()

	if err != nil {
		_ = dir.Close()
		return nil, err
	}

	err = testHost(urlStr, tunnel, directory, nil)

	if err != nil {
		_ = dir.Close()
		return nil, err
	}

	repository, err := dir.Repository()

	if err != nil {
		_ = dir.Close()
		return nil, err
	}

	return &types.ResponseStream{
		Open: func(ctx *types.Context, streamId uint8) {
			defer dir.Close()
			options := git.PushOptions{
				Progress: &GitStream{
					ctx:      ctx,
					streamId: streamId,
				},
			}

			clientOpts, err := dir.getClientOptions(ctx, urlStr, false)
			if err == nil {
				options.ClientOptions = clientOpts
			}

			err = repository.Push(&options)

			if errIsAuthenticationRequired(err) {
				clientOpts, err = dir.getClientOptions(ctx, urlStr, true)
				if err == nil {
					options.ClientOptions = clientOpts
					err = repository.Push(&options)
				}
			}

			if errIsAuthenticationRequired(err) {
				invalidateAuth(ctx, urlStr)
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
	defer dir.Close()

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
	defer dir.Close()

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
	defer dir.Close()

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

func checkout(directory string, ref string, create bool, tunnel string) (*types.ResponseStream, error) {
	return &types.ResponseStream{
		Open: func(ctx *types.Context, streamId uint8) {
			dir, err := OpenGitDirectory(directory)
			if err == nil {
				dir.Tunnel = tunnel
			}

			if err != nil {
				store.StreamChunk(ctx, streamId, []byte(err.Error()+"\n"), false)
				store.StreamChunk(ctx, streamId, nil, true)
				return
			}
			defer dir.Close()

			refType, remote, err := dir.FindRefType(ctx, ref)
			if err != nil {
				store.StreamChunk(ctx, streamId, []byte(err.Error()+"\n"), false)
				store.StreamChunk(ctx, streamId, nil, true)
				return
			}

			if create {
				refType = RefBranch
			}

			repository, err := dir.Repository()
			if err != nil {
				store.StreamChunk(ctx, streamId, []byte(err.Error()+"\n"), false)
				store.StreamChunk(ctx, streamId, nil, true)
				return
			}

			worktree, err := repository.Worktree()
			if err != nil {
				store.StreamChunk(ctx, streamId, []byte(err.Error()+"\n"), false)
				store.StreamChunk(ctx, streamId, nil, true)
				return
			}

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

			if err != nil {
				store.StreamChunk(ctx, streamId, []byte(err.Error()+"\n"), false)
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
	defer dir.Close()

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
	return strings.Contains(err.Error(), transport.ErrAuthenticationRequired.Error())
}

func invalidateAuth(ctx *types.Context, urlStr string) {
	u, err := url.Parse(urlStr)
	if err != nil {
		return
	}
	if ctx.GitAuthsMutex == nil {
		ctx.GitAuthsMutex = &sync.Mutex{}
	}
	ctx.GitAuthsMutex.Lock()
	if ctx.GitAuths != nil {
		delete(ctx.GitAuths, u.Host)
	}
	ctx.GitAuthsMutex.Unlock()
}

func testHost(urlStr string, tunnel string, directory string, proxy *GitProxy) error {
	u, err := url.Parse(urlStr)
	if err != nil {
		return err
	}

	var baseTransport nethttp.RoundTripper = nethttp.DefaultTransport
	var transport *nethttp.Transport

	var proxyURL *url.URL
	var proxyHeaders map[string]string

	// 1. Resolve basic transport
	if tunnel != "" {
		t := tunnelPkg.FindTunnel(tunnel)
		if t == nil {
			return errors.New("tunnel not found")
		}
		transport = &nethttp.Transport{
			DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
				return t.Dial(ctx)
			},
		}
		baseTransport = transport
	} else if proxy != nil && proxy.Url != "" {
		proxyStr := proxy.Url
		if !strings.HasPrefix(proxyStr, "http://") && !strings.HasPrefix(proxyStr, "https://") {
			proxyStr = "http://" + proxyStr
		}
		var err error
		proxyURL, err = url.Parse(proxyStr)
		if err == nil {
			transport = nethttp.DefaultTransport.(*nethttp.Transport).Clone()
			baseTransport = transport
			proxyHeaders = proxy.Headers
		}
	} else if directory != "" {
		dir, err := OpenGitDirectory(directory)
		if err == nil {
			defer dir.Close()
			cfg, err := dir.repository.Config()
			if err == nil && cfg.Raw != nil {
				sec := cfg.Raw.Section("http")
				if sec != nil {
					proxyStr := sec.Option("proxy")
					if proxyStr != "" {
						var err error
						proxyURL, err = url.Parse(proxyStr)
						if err == nil {
							transport = nethttp.DefaultTransport.(*nethttp.Transport).Clone()
							baseTransport = transport

							// Extract extra headers
							extraHeaders := sec.OptionAll("extraHeader")
							if len(extraHeaders) > 0 {
								proxyHeaders = make(map[string]string)
								for _, header := range extraHeaders {
									parts := strings.SplitN(header, ":", 2)
									if len(parts) == 2 {
										proxyHeaders[strings.TrimSpace(parts[0])] = strings.TrimSpace(parts[1])
									}
								}
							}
						}
					}
				}
			}
		}
	}

	// 3. Configure reverse proxy RoundTripper if proxyURL is present
	if proxyURL != nil {
		baseTransport = &reverseProxyRoundTripper{
			proxyURL:     proxyURL,
			proxyHeaders: proxyHeaders,
			base:         baseTransport,
		}
	}

	// 4. Add extra headers wrapping
	if proxy != nil && proxy.Url != "" {
		if len(proxy.Headers) > 0 {
			headersSlice := make([]string, 0, len(proxy.Headers))
			for k, v := range proxy.Headers {
				headersSlice = append(headersSlice, fmt.Sprintf("%s: %s", k, v))
			}
			baseTransport = &headerRoundTripper{
				base:    baseTransport,
				headers: headersSlice,
			}
		}
	} else if directory != "" {
		dir, err := OpenGitDirectory(directory)
		if err == nil {
			defer dir.Close()
			cfg, err := dir.repository.Config()
			if err == nil && cfg.Raw != nil {
				sec := cfg.Raw.Section("http")
				if sec != nil {
					extraHeaders := sec.OptionAll("extraHeader")
					if len(extraHeaders) > 0 {
						baseTransport = &headerRoundTripper{
							base:    baseTransport,
							headers: extraHeaders,
						}
					}
				}
			}
		}
	}

	client := nethttp.Client{
		Timeout:   5 * time.Second,
		Transport: baseTransport,
	}

	resp, err := client.Head(fmt.Sprintf("%s://%s", u.Scheme, u.Host))
	if err != nil {
		return err
	}

	return resp.Body.Close()
}

func parseConfigKey(key string) (section, subsection, option string, err error) {
	parts := strings.Split(key, ".")
	if len(parts) < 2 {
		return "", "", "", fmt.Errorf("invalid config key: %s", key)
	}
	if len(parts) == 2 {
		return parts[0], "", parts[1], nil
	}
	return parts[0], strings.Join(parts[1:len(parts)-1], "."), parts[len(parts)-1], nil
}

func setConfig(directory string, key string, value string) error {
	var repo *git.Repository
	var err error
	if USE_CUSTOM_FS {
		repo, err = CustomOpen(directory)
	} else {
		repo, err = git.PlainOpen(directory)
	}
	if err != nil {
		return err
	}
	defer repo.Close()

	cfg, err := repo.Config()
	if err != nil {
		return err
	}

	section, subsection, option, err := parseConfigKey(key)
	if err != nil {
		return err
	}

	if cfg.Raw == nil {
		cfg.Raw = formatconfig.New()
	}

	cfg.Raw.SetOption(section, subsection, option, value)

	return repo.SetConfig(cfg)
}

func restore(directory string, paths []string) error {
	dir, err := OpenGitDirectory(directory)

	if err != nil {
		return err
	}
	defer dir.Close()

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
