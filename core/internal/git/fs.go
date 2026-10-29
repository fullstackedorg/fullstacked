// Package git provides Git operations.
// fs.go implements CustomFS (a billy.Filesystem using standard 'os' package functions)
// to avoid macOS sandbox permission issues with go-billy's default os.Root usage.
package git

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-git/go-billy/v6"
	git "github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/plumbing/cache"
	"github.com/go-git/go-git/v6/plumbing/transport"
	"github.com/go-git/go-git/v6/storage/filesystem"
	"github.com/go-git/go-git/v6/storage/filesystem/dotgit"
)

// CustomFS is a billy.Filesystem implementation that uses the default Go os package functions.
type CustomFS struct {
	baseDir string
}

// NewCustomFS creates a new CustomFS filesystem rooted at baseDir.
func NewCustomFS(baseDir string) billy.Filesystem {
	return &CustomFS{baseDir: filepath.Clean(baseDir)}
}

// resolve resolves the given path relative to the virtual filesystem root.
func (fsys *CustomFS) resolve(path string) string {
	clean := filepath.Clean(filepath.Join("/", path))
	return filepath.Join(fsys.baseDir, clean)
}

// customFile wraps an *os.File to implement the billy.File interface.
type customFile struct {
	*os.File
	name string
}

func (f *customFile) Name() string {
	return f.name
}

// Basic interface implementation

func (fsys *CustomFS) Create(filename string) (billy.File, error) {
	return fsys.OpenFile(filename, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0666)
}

func (fsys *CustomFS) Open(filename string) (billy.File, error) {
	return fsys.OpenFile(filename, os.O_RDONLY, 0)
}

func (fsys *CustomFS) OpenFile(filename string, flag int, perm fs.FileMode) (billy.File, error) {
	resolved := fsys.resolve(filename)
	if flag&os.O_CREATE != 0 {
		if err := os.MkdirAll(filepath.Dir(resolved), 0777); err != nil {
			return nil, err
		}
	}
	f, err := os.OpenFile(resolved, flag, perm)
	if err != nil {
		return nil, err
	}
	return &customFile{File: f, name: filename}, nil
}

func (fsys *CustomFS) Stat(filename string) (fs.FileInfo, error) {
	resolved := fsys.resolve(filename)
	return os.Stat(resolved)
}

func (fsys *CustomFS) Rename(oldpath, newpath string) error {
	oldResolved := fsys.resolve(oldpath)
	newResolved := fsys.resolve(newpath)
	if err := os.MkdirAll(filepath.Dir(newResolved), 0777); err != nil {
		return err
	}
	return os.Rename(oldResolved, newResolved)
}

func (fsys *CustomFS) Remove(filename string) error {
	resolved := fsys.resolve(filename)
	return os.Remove(resolved)
}

func (fsys *CustomFS) Join(elem ...string) string {
	return filepath.Join(elem...)
}

// TempFile interface implementation

func (fsys *CustomFS) TempFile(dir, prefix string) (billy.File, error) {
	resolvedDir := fsys.resolve(dir)
	if err := os.MkdirAll(resolvedDir, 0777); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(resolvedDir, prefix)
	if err != nil {
		return nil, err
	}
	relName, err := filepath.Rel(fsys.baseDir, f.Name())
	if err != nil {
		relName = f.Name()
	}
	return &customFile{File: f, name: relName}, nil
}

// Dir interface implementation

func (fsys *CustomFS) ReadDir(path string) ([]fs.DirEntry, error) {
	resolved := fsys.resolve(path)
	return os.ReadDir(resolved)
}

func (fsys *CustomFS) MkdirAll(filename string, perm fs.FileMode) error {
	resolved := fsys.resolve(filename)
	return os.MkdirAll(resolved, perm)
}

// Symlink interface implementation

func (fsys *CustomFS) Lstat(filename string) (fs.FileInfo, error) {
	resolved := fsys.resolve(filename)
	return os.Lstat(resolved)
}

func (fsys *CustomFS) Symlink(target, link string) error {
	linkResolved := fsys.resolve(link)
	if err := os.MkdirAll(filepath.Dir(linkResolved), 0777); err != nil {
		return err
	}
	return os.Symlink(target, linkResolved)
}

func (fsys *CustomFS) Readlink(link string) (string, error) {
	resolved := fsys.resolve(link)
	target, err := os.Readlink(resolved)
	if err != nil {
		return "", err
	}
	return filepath.ToSlash(target), nil
}

// Chroot interface implementation

func (fsys *CustomFS) Chroot(path string) (billy.Filesystem, error) {
	resolved := fsys.resolve(path)
	return NewCustomFS(resolved), nil
}

func (fsys *CustomFS) Root() string {
	return fsys.baseDir
}

// Capable interface implementation

func (fsys *CustomFS) Capabilities() billy.Capability {
	return billy.AllCapabilities
}

// Change interface implementation

func (fsys *CustomFS) Chmod(name string, mode fs.FileMode) error {
	return os.Chmod(fsys.resolve(name), mode)
}

func (fsys *CustomFS) Lchown(name string, uid, gid int) error {
	return os.Lchown(fsys.resolve(name), uid, gid)
}

func (fsys *CustomFS) Chown(name string, uid, gid int) error {
	return os.Chown(fsys.resolve(name), uid, gid)
}

func (fsys *CustomFS) Chtimes(name string, atime time.Time, mtime time.Time) error {
	return os.Chtimes(fsys.resolve(name), atime, mtime)
}

// Custom Git helper operations

func CustomOpen(path string) (*git.Repository, error) {
	return CustomOpenWithOptions(path, &git.PlainOpenOptions{})
}

func CustomOpenWithOptions(path string, o *git.PlainOpenOptions) (*git.Repository, error) {
	if o == nil {
		o = &git.PlainOpenOptions{}
	}

	var err error
	path, err = replaceTildeWithHome(path)
	if err != nil {
		return nil, err
	}

	path, err = filepath.Abs(path)
	if err != nil {
		return nil, err
	}

	var dot, wt billy.Filesystem
	var fi os.FileInfo
	currPath := path

	for {
		fsRoot := NewCustomFS(currPath)

		pathinfo, err := fsRoot.Stat("/")
		if !errors.Is(err, os.ErrNotExist) {
			if pathinfo == nil {
				return nil, err
			}
			if !pathinfo.IsDir() && o.DetectDotGit {
				fsRoot = NewCustomFS(filepath.Dir(currPath))
			}
		}

		fi, err = fsRoot.Stat(git.GitDirName)
		if err == nil {
			break
		}
		if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		if o.DetectDotGit {
			if dir := filepath.Dir(currPath); dir != currPath {
				currPath = dir
				continue
			}
		}

		dot = fsRoot
		break
	}

	if fi != nil {
		if fi.IsDir() {
			dot, err = NewCustomFS(currPath).Chroot(git.GitDirName)
			if err != nil {
				return nil, err
			}
			wt = NewCustomFS(currPath)
		} else {
			dot, err = dotGitFileToCustomFilesystem(currPath, NewCustomFS(currPath))
			if err != nil {
				return nil, err
			}
			wt = NewCustomFS(currPath)
		}
	}

	if _, err := dot.Stat(""); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, git.ErrRepositoryNotExists
		}
		return nil, err
	}

	dotGitCommon, err := dotGitCommonDirectory(dot)
	if err != nil {
		return nil, err
	}
	repositoryFs := dotgit.NewRepositoryFilesystem(dot, dotGitCommon)

	s := filesystem.NewStorage(repositoryFs, cache.NewObjectLRUDefault())

	r, err := git.Open(s, wt)
	if err != nil {
		_ = s.Close()
		return nil, err
	}
	return r, nil
}

func CustomInit(path string, isBare bool, options ...git.InitOption) (*git.Repository, error) {
	var err error
	if !filepath.IsAbs(path) {
		path, err = filepath.Abs(path)
		if err != nil {
			return nil, err
		}
	}

	var wt, dot billy.Filesystem
	var initFn func(s *filesystem.Storage) (*git.Repository, error)

	if isBare {
		dot = NewCustomFS(path)
		initFn = func(s *filesystem.Storage) (*git.Repository, error) {
			return git.Init(s, options...)
		}
	} else {
		wt = NewCustomFS(path)
		dot, err = wt.Chroot(git.GitDirName)
		if err != nil {
			return nil, err
		}
		initFn = func(s *filesystem.Storage) (*git.Repository, error) {
			oo := make([]git.InitOption, 0, 1+len(options))
			oo = append(oo, git.WithWorkTree(wt))
			oo = append(oo, options...)
			return git.Init(s, oo...)
		}
	}

	s := filesystem.NewStorage(dot, cache.NewObjectLRUDefault())
	r, err := initFn(s)
	if err != nil {
		return nil, err
	}

	cfg, err := r.Config()
	if err != nil {
		_ = r.Close()
		return nil, err
	}

	err = r.Storer.SetConfig(cfg)
	if err != nil {
		_ = r.Close()
		return nil, err
	}

	return r, nil
}

func CustomCloneContext(ctx context.Context, path string, o *git.CloneOptions) (*git.Repository, error) {
	if o == nil {
		o = &git.CloneOptions{}
	}

	empty, err := checkTargetDirIsEmpty(path)
	if err != nil {
		return nil, err
	}
	if !empty {
		return nil, fmt.Errorf("%w %s", git.ErrTargetDirNotEmpty, path)
	}

	isBare := o.Bare
	if o.Mirror {
		isBare = true
	}

	_, preErr := os.Stat(path)
	dirPreexisted := !os.IsNotExist(preErr)

	var wt, dot billy.Filesystem
	if isBare {
		dot = NewCustomFS(path)
	} else {
		wt = NewCustomFS(path)
		dot, err = wt.Chroot(git.GitDirName)
		if err != nil {
			return nil, err
		}
	}

	s := filesystem.NewStorage(dot, cache.NewObjectLRUDefault())
	r, err := git.CloneContext(ctx, s, wt, o)
	if err != nil {
		if o.AllowEmptyRepo && errors.Is(err, transport.ErrEmptyRemoteRepository) {
			return r, nil
		}
		if r != nil {
			_ = r.Close()
		} else {
			_ = s.Close()
		}
		if dirPreexisted {
			_ = os.RemoveAll(filepath.Join(path, git.GitDirName))
		} else {
			_ = os.RemoveAll(path)
		}
		return nil, err
	}

	return r, nil
}

func checkTargetDirIsEmpty(path string) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return true, nil
		}
		return false, err
	}
	defer f.Close()

	_, err = f.Readdirnames(1)
	if err == io.EOF {
		return true, nil
	}
	return false, err
}

func dotGitFileToCustomFilesystem(path string, fsys billy.Filesystem) (billy.Filesystem, error) {
	f, err := fsys.Open(git.GitDirName)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	b, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}

	line := string(b)
	const prefix = "gitdir: "
	if !strings.HasPrefix(line, prefix) {
		return nil, fmt.Errorf("invalid gitdir file format")
	}

	gitdir := strings.Split(line[len(prefix):], "\n")[0]
	gitdir = strings.TrimSpace(gitdir)
	if filepath.IsAbs(gitdir) {
		return NewCustomFS(gitdir), nil
	}

	return NewCustomFS(fsys.Join(path, gitdir)), nil
}

func dotGitCommonDirectory(fsys billy.Filesystem) (billy.Filesystem, error) {
	f, err := fsys.Open("commondir")
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()

	b, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}

	var commonDir billy.Filesystem
	if len(b) > 0 {
		path := strings.TrimSpace(string(b))
		if filepath.IsAbs(path) {
			commonDir = NewCustomFS(path)
		} else {
			commonDir = NewCustomFS(filepath.Join(fsys.Root(), path))
		}
		if _, err := commonDir.Stat(""); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil, git.ErrRepositoryIncomplete
			}
			return nil, err
		}
	}

	return commonDir, nil
}

func replaceTildeWithHome(path string) (string, error) {
	if !strings.HasPrefix(path, "~") {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if path == "~" {
		return home, nil
	}
	if strings.HasPrefix(path, "~/") {
		return filepath.Join(home, path[2:]), nil
	}
	return path, nil
}
