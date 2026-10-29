package packages

import (
	"bufio"
	"fullstackedorg/fullstacked/internal/fs"
	iofs "io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-git/go-git/v6/plumbing/format/gitignore"
)

// packGitCheckout trims a cloned git dependency to what npm installs from
// it: npm packs the repository, leaving out what its .npmignore excludes
// (its .gitignore when it has no .npmignore), then the files npm never
// packs. package.json always stays.
func packGitCheckout(dir string) {
	ignoreFile := filepath.Join(dir, ".npmignore")
	if !fs.ExistsFn(ignoreFile) {
		ignoreFile = filepath.Join(dir, ".gitignore")
	}
	if patterns := readIgnorePatterns(ignoreFile); len(patterns) > 0 {
		matcher := gitignore.NewMatcher(patterns)
		filepath.WalkDir(dir, func(p string, d iofs.DirEntry, err error) error {
			if err != nil || p == dir {
				return nil
			}
			rel, _ := filepath.Rel(dir, p)
			if rel == ".git" || rel == "package.json" {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			if matcher.Match(strings.Split(filepath.ToSlash(rel), "/"), d.IsDir()) {
				os.RemoveAll(p)
				if d.IsDir() {
					return filepath.SkipDir
				}
			}
			return nil
		})
	}

	for _, name := range []string{".git", ".gitignore", ".npmignore", "package-lock.json"} {
		fs.RmFn(filepath.Join(dir, name))
	}
}

func readIgnorePatterns(file string) []gitignore.Pattern {
	f, err := os.Open(file)
	if err != nil {
		return nil
	}
	defer f.Close()

	var patterns []gitignore.Pattern
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		if strings.TrimSpace(line) == "" || strings.HasPrefix(line, "#") {
			continue
		}
		patterns = append(patterns, gitignore.ParsePattern(line, nil))
	}
	return patterns
}
