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
