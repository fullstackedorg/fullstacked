package packages

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

func files(t *testing.T, dir string) []string {
	var out []string
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(dir, p)
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(out)
	return out
}

func write(t *testing.T, dir string, name string, content string) {
	p := filepath.Join(dir, name)
	os.MkdirAll(filepath.Dir(p), 0755)
	if err := os.WriteFile(p, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestPackGitCheckoutNpmignore(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, ".npmignore", ".gitignore\ntest\n*.log\n")
	write(t, dir, ".gitignore", "index.js\n")
	write(t, dir, ".git/HEAD", "ref")
	write(t, dir, "package.json", "{}")
	write(t, dir, "package-lock.json", "{}")
	write(t, dir, "index.js", "")
	write(t, dir, "index.ts", "")
	write(t, dir, "debug.log", "")
	write(t, dir, "test/index.ts", "")
	write(t, dir, "src/test.ts", "")

	packGitCheckout(dir)

	// .gitignore is not read when a .npmignore exists: index.js stays;
	// "test" matches the directory, src/test.ts is a file named test.ts
	want := []string{"index.js", "index.ts", "package.json", "src/test.ts"}
	if got := files(t, dir); !equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestPackGitCheckoutGitignore(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, ".gitignore", "out/\n# comment\n\nnode_modules\n")
	write(t, dir, "package.json", "{}")
	write(t, dir, "index.ts", "")
	write(t, dir, "out/index.js", "")
	write(t, dir, "node_modules/a/index.js", "")

	packGitCheckout(dir)

	want := []string{"index.ts", "package.json"}
	if got := files(t, dir); !equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func equal(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
