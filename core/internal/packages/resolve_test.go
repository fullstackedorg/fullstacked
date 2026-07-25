package packages

import (
	"fullstackedorg/fullstacked/types"
	"os"
	"path/filepath"
	"testing"
)

func TestAddNodePath(t *testing.T) {
	tmpDir := t.TempDir()
	ctx := &types.Context{
		Directories: types.ContextDirectories{
			Root: tmpDir,
		},
		Cwd: "sub",
	}

	// Test 1: Relative path
	err := addNodePath(ctx, "custom_modules")
	if err != nil {
		t.Fatalf("unexpected error for relative path: %v", err)
	}
	if len(ctx.NodePaths) != 1 || ctx.NodePaths[0] != "sub/custom_modules" {
		t.Fatalf("expected 'sub/custom_modules', got %v", ctx.NodePaths)
	}

	// Test 2: Absolute path within root
	absPath := filepath.Join(tmpDir, "global_modules")
	err = addNodePath(ctx, absPath)
	if err != nil {
		t.Fatalf("unexpected error for absolute path: %v", err)
	}
	if len(ctx.NodePaths) != 2 || ctx.NodePaths[1] != "global_modules" {
		t.Fatalf("expected 'global_modules', got %v", ctx.NodePaths)
	}

	// Test 3: Escaping path
	err = addNodePath(ctx, "../../outside")
	if err == nil {
		t.Fatalf("expected error for escaping path, got nil")
	}
}

func TestResolveModule(t *testing.T) {
	tmpDir := t.TempDir()
	ctx := &types.Context{
		Directories: types.ContextDirectories{
			Root: tmpDir,
		},
	}

	// Setup directory structure:
	// tmpDir/
	//   app/
	//     node_modules/
	//       foo/
	//         index.js
	//     src/
	//       index.ts
	//   node_modules/
	//     bar/
	//       package.json (main: dist/main.js)
	//       dist/
	//         main.js
	//   custom/
	//     baz/
	//       index.ts

	appDir := filepath.Join(tmpDir, "app")
	srcDir := filepath.Join(appDir, "src")
	fooDir := filepath.Join(appDir, "node_modules", "foo")
	barDir := filepath.Join(tmpDir, "node_modules", "bar")
	barDistDir := filepath.Join(barDir, "dist")
	bazDir := filepath.Join(tmpDir, "custom", "baz")

	os.MkdirAll(srcDir, 0755)
	os.MkdirAll(fooDir, 0755)
	os.MkdirAll(barDistDir, 0755)
	os.MkdirAll(bazDir, 0755)

	os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte("console.log('src');"), 0644)
	os.WriteFile(filepath.Join(fooDir, "index.js"), []byte("module.exports = 'foo';"), 0644)
	os.WriteFile(filepath.Join(barDir, "package.json"), []byte(`{"main": "dist/main.js"}`), 0644)
	os.WriteFile(filepath.Join(barDistDir, "main.js"), []byte("module.exports = 'bar';"), 0644)
	os.WriteFile(filepath.Join(bazDir, "index.ts"), []byte("module.exports = 'baz';"), 0644)

	// Add custom node path
	_ = addNodePath(ctx, "custom")

	// Test LOAD_AS_FILE / LOAD_AS_DIRECTORY for relative file
	res, err := resolveModule(ctx, "./index", srcDir)
	if err != nil || res != "app/src/index.ts" {
		t.Fatalf("expected 'app/src/index.ts', got res=%s, err=%v", res, err)
	}

	// Test parent node_modules resolution (foo in app/node_modules)
	res, err = resolveModule(ctx, "foo", srcDir)
	if err != nil || res != "app/node_modules/foo/index.js" {
		t.Fatalf("expected 'app/node_modules/foo/index.js', got res=%s, err=%v", res, err)
	}

	// Test root node_modules walking up (bar with package.json main)
	res, err = resolveModule(ctx, "bar", srcDir)
	if err != nil || res != "node_modules/bar/dist/main.js" {
		t.Fatalf("expected 'node_modules/bar/dist/main.js', got res=%s, err=%v", res, err)
	}

	// Test NodePaths fallback (baz in custom/baz)
	res, err = resolveModule(ctx, "baz", srcDir)
	if err != nil || res != "custom/baz/index.ts" {
		t.Fatalf("expected 'custom/baz/index.ts', got res=%s, err=%v", res, err)
	}

	// Test cwd relative path when ctx.Cwd is set to "app"
	ctx.Cwd = "app"
	res, err = resolveModule(ctx, "foo", srcDir)
	if err != nil || res != "node_modules/foo/index.js" {
		t.Fatalf("expected 'node_modules/foo/index.js' when Cwd='app', got res=%s, err=%v", res, err)
	}

	// Test not found error
	_, err = resolveModule(ctx, "nonexistent", srcDir)
	if err == nil {
		t.Fatalf("expected error for nonexistent module, got nil")
	}
}
