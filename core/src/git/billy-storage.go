package git

import (
	"errors"
	"fmt"
	fs "fullstackedorg/fullstacked/src/fs"
	utils "fullstackedorg/fullstacked/src/utils"
	"io"
	ioFs "io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var fileEventOrigin = "git"

type storage struct {
	Root     string          // track the base directory
	wg       *sync.WaitGroup // global wait group to wait for all writeTofile to finish
	files    map[string]*file
	children map[string]map[string]*file
}

func newStorage(root string, wg *sync.WaitGroup) *storage {
	return &storage{
		Root:     root,
		wg:       wg,
		files:    make(map[string]*file, 0),
		children: make(map[string]map[string]*file, 0),
	}
}

func (s *storage) Has(path string) bool {
	path = clean(path)

	_, ok := s.files[path]
	return ok
}

func (s *storage) New(path string, mode ioFs.FileMode, flag int) (*file, error) {
	path = clean(path)
	if s.Has(path) {
		if !s.MustGet(path).mode.IsDir() {
			return nil, fmt.Errorf("file already exists %q", path)
		}

		return nil, nil
	}

	name := filepath.Base(path)

	// track real full filePath
	filePath := filepath.Join(s.Root, path)
	//end

	content := &content{
		name:     name,
		path:     filePath,
		debounce: utils.NewDebouncer(time.Millisecond * 50), // 50ms
	}

	// debounce the write func
	// avoids writing the file at every writeAt
	content.writeToFile = func() func() {
		// lock to prevent operation happening before write
		if content.debounceLock.TryLock() && s.wg != nil {
			s.wg.Add(1)
		}

		return func() {
			fs.WriteFile(filePath, content.bytes, fileEventOrigin)
			content.debounceLock.Unlock()
			if s.wg != nil {
				s.wg.Done()
			}
		}
	}

	f := &file{
		name:    name,
		content: content,
		mode:    mode,
		flag:    flag,
		modTime: time.Now(),
	}

	s.files[path] = f
	err := s.createParent(path, mode, f)
	if err != nil {
		return nil, fmt.Errorf("failed to create parent: %w", err)
	}

	// if doesnt exists on real fs
	// create file or directory
	exists, _ := fs.Exists(filePath)
	if !exists {
		if mode.IsDir() {
			fs.Mkdir(filePath, fileEventOrigin)
		} else {
			fs.WriteFile(filePath, []byte{}, fileEventOrigin)
		}
	}
	// end

	return f, nil
}

func (s *storage) createParent(path string, mode ioFs.FileMode, f *file) error {
	base := filepath.Dir(path)
	base = clean(base)
	if f.Name() == string(separator) {
		return nil
	}

	if _, err := s.New(base, mode.Perm()|os.ModeDir, 0); err != nil {
		return err
	}

	if _, ok := s.children[base]; !ok {
		s.children[base] = make(map[string]*file, 0)
	}

	s.children[base][f.Name()] = f
	return nil
}

func (s *storage) Children(path string) []*file {
	path = clean(path)

	l := make([]*file, 0)
	for _, f := range s.children[path] {
		l = append(l, f)
	}

	return l
}

func (s *storage) MustGet(path string) *file {
	f, ok := s.Get(path)
	if !ok {
		panic(fmt.Errorf("couldn't find %q", path))
	}

	return f
}

func (s *storage) Get(path string) (*file, bool) {
	path = clean(path)

	// if path isnt in memory
	// check if exists in real fs and load into memory
	if !s.Has(path) &&
		filepath.ToSlash(path) != "/.git" { // that's probably a bug
		filePath := filepath.Join(s.Root, path)
		exists, _ := fs.Exists(filePath)
		if exists {
			stats, _ := fs.Stat(filePath)
			s.New(path, stats.Mode, 0)
		}
	}
	// end

	if !s.Has(path) {
		return nil, false
	}

	file, ok := s.files[path]
	return file, ok
}

func (s *storage) Rename(from, to string) error {
	from = clean(from)
	to = clean(to)

	if !s.Has(from) {
		return os.ErrNotExist
	}

	move := [][2]string{{from, to}}

	for pathFrom := range s.files {
		if pathFrom == from || !strings.HasPrefix(pathFrom, from) {
			continue
		}

		rel, _ := filepath.Rel(from, pathFrom)
		pathTo := filepath.Join(to, rel)

		move = append(move, [2]string{pathFrom, pathTo})
	}

	for _, ops := range move {
		from := ops[0]
		to := ops[1]

		if err := s.move(from, to); err != nil {
			return err
		}
	}

	// rename on real fs
	fromPath := filepath.Join(s.Root, from)
	toPath := filepath.Join(s.Root, to)
	fs.Rename(fromPath, toPath, fileEventOrigin)
	// end

	return nil
}

func (s *storage) move(from, to string) error {
	// make sure there is no debounced writeToFile
	s.files[from].content.debounceLock.Lock()
	// end

	s.files[to] = s.files[from]
	s.files[to].name = filepath.Base(to)
	s.children[to] = s.children[from]

	defer func() {
		s.files[from].content.debounceLock.Unlock()
		delete(s.children, from)
		delete(s.files, from)
		delete(s.children[filepath.Dir(from)], filepath.Base(from))
	}()

	return s.createParent(to, 0644, s.files[to])
}

func (s *storage) Remove(path string) error {
	path = clean(path)

	f, has := s.Get(path)
	if !has {
		return os.ErrNotExist
	}

	if f.mode.IsDir() && len(s.children[path]) != 0 {
		return fmt.Errorf("dir: %s contains files", path)
	}

	base, file := filepath.Split(path)
	base = filepath.Clean(base)

	// remove on real fs
	if f.mode.IsDir() {
		fs.Rmdir(f.content.path, fileEventOrigin)
	} else {
		fs.Unlink(f.content.path, fileEventOrigin)
	}
	// end

	delete(s.children[base], file)
	delete(s.files, path)
	return nil
}

func clean(path string) string {
	return filepath.Clean(filepath.FromSlash(path))
}

type content struct {
	name  string
	path  string
	bytes []byte

	m sync.RWMutex

	debounceLock sync.Mutex
	debounce     func(fn func())
	writeToFile  func() func()
}

func (c *content) WriteAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, &os.PathError{
			Op:   "writeat",
			Path: c.name,
			Err:  errors.New("negative offset"),
		}
	}

	c.m.Lock()
	prev := len(c.bytes)

	diff := int(off) - prev
	if diff > 0 {
		c.bytes = append(c.bytes, make([]byte, diff)...)
	}

	c.bytes = append(c.bytes[:off], p...)
	if len(c.bytes) < prev {
		c.bytes = c.bytes[:prev]
	}
	c.m.Unlock()

	// write to real file, debounced
	c.debounce(c.writeToFile())
	//end

	return len(p), nil
}

func (c *content) ReadAt(b []byte, off int64) (n int, err error) {
	// if file never been read,
	// load data once
	if c.bytes == nil {
		data, _ := fs.ReadFile(c.path)
		c.bytes = data
	}
	// end

	if off < 0 {
		return 0, &os.PathError{
			Op:   "readat",
			Path: c.name,
			Err:  errors.New("negative offset"),
		}
	}

	c.m.RLock()
	size := int64(len(c.bytes))
	if off >= size {
		c.m.RUnlock()
		return 0, io.EOF
	}

	l := int64(len(b))
	if off+l > size {
		l = size - off
	}

	btr := c.bytes[off : off+l]
	n = copy(b, btr)

	if len(btr) < len(b) {
		err = io.EOF
	}
	c.m.RUnlock()

	return
}
