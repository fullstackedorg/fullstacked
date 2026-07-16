package git

import (
	"context"
	"errors"
	"fmt"
	"fullstackedorg/fullstacked/internal/tunnel"
	"fullstackedorg/fullstacked/types"
	"net"
	nethttp "net/http"
	"net/url"
	"strings"
	"sync"

	git "github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/config"
	"github.com/go-git/go-git/v6/plumbing"
	"github.com/go-git/go-git/v6/plumbing/client"
)

type headerRoundTripper struct {
	base    nethttp.RoundTripper
	headers []string
}

func (h *headerRoundTripper) RoundTrip(req *nethttp.Request) (*nethttp.Response, error) {
	for _, header := range h.headers {
		parts := strings.SplitN(header, ":", 2)
		if len(parts) == 2 {
			req.Header.Add(strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1]))
		}
	}
	return h.base.RoundTrip(req)
}

type GitDirectory struct {
	Directory  string
	Tunnel     string
	Proxy      *GitProxy
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

func (r *GitDirectory) Close() error {
	if r.repository != nil {
		err := r.repository.Close()
		r.repository = nil
		r.worktree = nil
		return err
	}
	return nil
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

	var baseTransport nethttp.RoundTripper = nethttp.DefaultTransport
	var transport *nethttp.Transport
	hasCustomClient := false

	var proxyURL *url.URL
	var proxyHeaders map[string]string

	// 1. Resolve basic transport
	if r.Tunnel != "" {
		t := tunnel.FindTunnel(r.Tunnel)
		if t == nil {
			return nil, errors.New("tunnel not found")
		}
		transport = &nethttp.Transport{
			DialContext: func(netCtx context.Context, network, addr string) (net.Conn, error) {
				return t.Dial(netCtx)
			},
		}
		baseTransport = transport
		hasCustomClient = true
	} else if r.Proxy != nil && r.Proxy.Url != "" {
		proxyStr := r.Proxy.Url
		if !strings.HasPrefix(proxyStr, "http://") && !strings.HasPrefix(proxyStr, "https://") {
			proxyStr = "http://" + proxyStr
		}
		var err error
		proxyURL, err = url.Parse(proxyStr)
		if err == nil {
			transport = nethttp.DefaultTransport.(*nethttp.Transport).Clone()
			baseTransport = transport
			hasCustomClient = true
			proxyHeaders = r.Proxy.Headers
		}
	} else if r.repository != nil {
		cfg, err := r.repository.Config()
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
						hasCustomClient = true

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

	// 3. Configure reverse proxy RoundTripper if proxyURL is present
	if proxyURL != nil {
		baseTransport = &reverseProxyRoundTripper{
			proxyURL:     proxyURL,
			proxyHeaders: proxyHeaders,
			base:         baseTransport,
		}
		hasCustomClient = true
	}

	// 4. Add extra headers wrapping
	if r.Proxy != nil && r.Proxy.Url != "" {
		if len(r.Proxy.Headers) > 0 {
			headersSlice := make([]string, 0, len(r.Proxy.Headers))
			for k, v := range r.Proxy.Headers {
				headersSlice = append(headersSlice, fmt.Sprintf("%s: %s", k, v))
			}
			baseTransport = &headerRoundTripper{
				base:    baseTransport,
				headers: headersSlice,
			}
		}
	} else if r.repository != nil {
		cfg, err := r.repository.Config()
		if err == nil && cfg.Raw != nil {
			sec := cfg.Raw.Section("http")
			if sec != nil {
				extraHeaders := sec.OptionAll("extraHeader")
				if len(extraHeaders) > 0 {
					baseTransport = &headerRoundTripper{
						base:    baseTransport,
						headers: extraHeaders,
					}
					hasCustomClient = true
				}
			}
		}
	}

	if hasCustomClient {
		customClient := &nethttp.Client{
			Transport: baseTransport,
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

	err = testHost(urlStr, r.Tunnel, r.Directory, r.Proxy)

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

	if errIsAuthenticationRequired(err) {
		invalidateAuth(ctx, urlStr)
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

	if errIsAuthenticationRequired(err) {
		invalidateAuth(progress.ctx, urlStr)
	}

	if errors.Is(err, git.NoErrAlreadyUpToDate) {
		err = nil
	}

	return err
}

type reverseProxyRoundTripper struct {
	proxyURL     *url.URL
	proxyHeaders map[string]string
	base         nethttp.RoundTripper
	originalHost string
	authHeader   string
	mu           sync.Mutex
}

func (r *reverseProxyRoundTripper) RoundTrip(req *nethttp.Request) (*nethttp.Response, error) {
	reqCopy := req.Clone(req.Context())

	r.mu.Lock()
	if r.originalHost == "" && req.URL.Host != r.proxyURL.Host {
		r.originalHost = req.URL.Host
	}
	if r.authHeader == "" {
		if auth := req.Header.Get("Authorization"); auth != "" {
			r.authHeader = auth
		}
	}
	originalHost := r.originalHost
	authHeader := r.authHeader
	r.mu.Unlock()

	if originalHost == "" {
		originalHost = req.URL.Host
	}

	reqCopy.Host = ""
	reqCopy.URL.Scheme = r.proxyURL.Scheme
	reqCopy.URL.Host = r.proxyURL.Host
	reqCopy.Header.Set("X-Proxy-Host", originalHost)

	if reqCopy.Header.Get("Authorization") == "" && authHeader != "" {
		reqCopy.Header.Set("Authorization", authHeader)
	}

	for k, v := range r.proxyHeaders {
		reqCopy.Header.Set(k, v)
	}
	resp, err := r.base.RoundTrip(reqCopy)
	if err != nil {
		return nil, err
	}

	// Restore the original request object so callers (Go-git) see the original HTTPS/host URL
	resp.Request = req

	if loc := resp.Header.Get("Location"); loc != "" && (resp.StatusCode >= 300 && resp.StatusCode < 400) {
		locURL, parseErr := url.Parse(loc)
		if parseErr == nil {
			resolvedURL := req.URL.ResolveReference(locURL)
			if resolvedURL.Host == r.proxyURL.Host || resolvedURL.Host == "" {
				resolvedURL.Host = originalHost
			}
			if req.URL.Scheme != "" {
				resolvedURL.Scheme = req.URL.Scheme
			} else {
				resolvedURL.Scheme = "https"
			}
			resp.Header.Set("Location", resolvedURL.String())
		}
	}

	return resp, nil
}
