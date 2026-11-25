package path

import (
	"fullstackedorg/fullstacked/types"
	"testing"
)

func TestRelativeToCwd(t *testing.T) {
	ctx := &types.Context{
		Directories: types.ContextDirectories{
			Root: "/home/user",
		},
		Cwd: "/",
	}

	res := RelativeToCwd(ctx, "/home/user/directory/file.ts")
	expected := "directory/file.ts"
	if res != expected {
		t.Errorf("Expected %q, got %q", expected, res)
	}

	ctx.Cwd = "/directory"
	res = RelativeToCwd(ctx, "/home/user/directory/file.ts")
	expected = "file.ts"
	if res != expected {
		t.Errorf("Expected %q, got %q", expected, res)
	}
}

func TestJoinUnderRoot(t *testing.T) {
	root := "/home/user/projects"
	under := map[string]string{
		"":                 root,
		".":                root,
		"/":                root,
		"demo":             root + "/demo",
		"/demo":            root + "/demo",
		"cloud/projects/a": root + "/cloud/projects/a",
		"a/../b":           root + "/b",
		"a/../../projects": root,
	}
	for p, expected := range under {
		res, ok := JoinUnderRoot(root, p)
		if !ok || res != expected {
			t.Errorf("JoinUnderRoot(%q) = %q, %v; expected %q, true", p, res, ok, expected)
		}
	}

	outside := []string{
		"..",
		"../",
		"../other",
		"/../other",
		"a/../../other",
		"a/../../../..",
		"../projects-other",
	}
	for _, p := range outside {
		if res, ok := JoinUnderRoot(root, p); ok {
			t.Errorf("JoinUnderRoot(%q) = %q, true; expected outside the root", p, res)
		}
	}
}
