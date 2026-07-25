package packages

import (
	"encoding/json"
	"errors"
	"fmt"
	"fullstackedorg/fullstacked/internal/fs"
	"fullstackedorg/fullstacked/types"
	"os"
	"path/filepath"
	"strings"
)

func addNodePath(ctx *types.Context, inputPath string) error {
	if ctx == nil {
		return errors.New("nil context")
	}

	var fullPath string
	if filepath.IsAbs(inputPath) {
		if strings.HasPrefix(inputPath, ctx.Directories.Root) {
			fullPath = inputPath
		} else {
			cleanInput := filepath.Clean(inputPath)
			if vol := filepath.VolumeName(cleanInput); vol != "" {
				cleanInput = strings.TrimPrefix(cleanInput, vol)
			}
			cleanInput = strings.TrimPrefix(cleanInput, string(filepath.Separator))
			fullPath = filepath.Join(ctx.Directories.Root, cleanInput)
		}
	} else {
		cwd := ctx.Cwd
		if cwd == "" {
			cwd = "."
		}
		fullPath = filepath.Join(ctx.Directories.Root, cwd, inputPath)
	}

	relPath, err := filepath.Rel(ctx.Directories.Root, fullPath)
	if err != nil || strings.HasPrefix(relPath, "..") || relPath == ".." {
		return errors.New("path escapes root directory")
	}

	relPath = filepath.ToSlash(filepath.Clean(relPath))
	ctx.NodePaths = append(ctx.NodePaths, relPath)
	return nil
}

func resolveModule(ctx *types.Context, moduleName string, startDir string) (string, error) {
	if ctx == nil {
		return "", errors.New("nil context")
	}

	isRelativeOrFile := strings.HasPrefix(moduleName, "./") ||
		strings.HasPrefix(moduleName, "../") ||
		filepath.IsAbs(moduleName) ||
		moduleName == "." ||
		moduleName == ".."

	if isRelativeOrFile {
		var targetPath string
		if filepath.IsAbs(moduleName) {
			targetPath = filepath.Join(ctx.Directories.Root, moduleName)
		} else {
			targetPath = filepath.Join(startDir, moduleName)
		}

		if res, ok := loadAsFile(targetPath); ok {
			return toRelToCwd(ctx, res)
		}
		if res, ok := loadAsDirectory(targetPath); ok {
			return toRelToCwd(ctx, res)
		}
		return "", fmt.Errorf("cannot find module '%s' from '%s'", moduleName, startDir)
	}

	// Step 1: NODE_MODULES_PATHS(startDir)
	currDir := startDir
	rootDir := ctx.Directories.Root

	for {
		targetPath := filepath.Join(currDir, "node_modules", moduleName)
		if res, ok := loadAsFile(targetPath); ok {
			return toRelToCwd(ctx, res)
		}
		if res, ok := loadAsDirectory(targetPath); ok {
			return toRelToCwd(ctx, res)
		}

		if currDir == rootDir || currDir == filepath.Dir(currDir) {
			break
		}
		parent := filepath.Dir(currDir)
		if !strings.HasPrefix(parent, rootDir) && parent != rootDir {
			if currDir != rootDir {
				targetPath = filepath.Join(rootDir, "node_modules", moduleName)
				if res, ok := loadAsFile(targetPath); ok {
					return toRelToCwd(ctx, res)
				}
				if res, ok := loadAsDirectory(targetPath); ok {
					return toRelToCwd(ctx, res)
				}
			}
			break
		}
		currDir = parent
	}

	// Step 2: Fallback to ctx.NodePaths
	for _, nodePath := range ctx.NodePaths {
		targetPath := filepath.Join(ctx.Directories.Root, nodePath, moduleName)
		if res, ok := loadAsFile(targetPath); ok {
			return toRelToCwd(ctx, res)
		}
		if res, ok := loadAsDirectory(targetPath); ok {
			return toRelToCwd(ctx, res)
		}
	}

	return "", fmt.Errorf("cannot find module '%s' from '%s'", moduleName, startDir)
}

func toRelToCwd(ctx *types.Context, absPath string) (string, error) {
	cwd := ctx.Cwd
	if cwd == "" {
		cwd = "."
	}
	var cwdAbs string
	if filepath.IsAbs(cwd) {
		cleanCwd := strings.TrimPrefix(filepath.Clean(cwd), string(filepath.Separator))
		cwdAbs = filepath.Join(ctx.Directories.Root, cleanCwd)
	} else {
		cwdAbs = filepath.Join(ctx.Directories.Root, cwd)
	}

	relPath, err := filepath.Rel(cwdAbs, absPath)
	if err != nil {
		return filepath.ToSlash(filepath.Clean(absPath)), nil
	}
	return filepath.ToSlash(filepath.Clean(relPath)), nil
}

func loadAsFile(targetPath string) (string, bool) {
	if isRegularFile(targetPath) {
		return targetPath, true
	}
	exts := []string{".ts", ".tsx", ".js", ".json", ".node"}
	for _, ext := range exts {
		candidate := targetPath + ext
		if isRegularFile(candidate) {
			return candidate, true
		}
	}
	return "", false
}

func loadAsDirectory(targetPath string) (string, bool) {
	if !isDirectory(targetPath) {
		return "", false
	}

	pkgJsonPath := filepath.Join(targetPath, "package.json")
	if isRegularFile(pkgJsonPath) {
		content, err := fs.ReadFileFn(pkgJsonPath)
		if err == nil {
			var pkg struct {
				Main    string          `json:"main"`
				Exports json.RawMessage `json:"exports"`
			}
			if json.Unmarshal(content, &pkg) == nil {
				if pkg.Main != "" {
					mainPath := filepath.Join(targetPath, pkg.Main)
					if res, ok := loadAsFile(mainPath); ok {
						return res, true
					}
					if res, ok := loadAsDirectory(mainPath); ok {
						return res, true
					}
				} else if len(pkg.Exports) > 0 {
					var expStr string
					if json.Unmarshal(pkg.Exports, &expStr) == nil && expStr != "" {
						expPath := filepath.Join(targetPath, expStr)
						if res, ok := loadAsFile(expPath); ok {
							return res, true
						}
						if res, ok := loadAsDirectory(expPath); ok {
							return res, true
						}
					}
				}
			}
		}
	}

	indexFiles := []string{"index.ts", "index.tsx", "index.js", "index.json"}
	for _, indexFile := range indexFiles {
		indexPath := filepath.Join(targetPath, indexFile)
		if isRegularFile(indexPath) {
			return indexPath, true
		}
	}

	return "", false
}

func isRegularFile(pathStr string) bool {
	info, err := os.Stat(pathStr)
	return err == nil && !info.IsDir()
}

func isDirectory(pathStr string) bool {
	info, err := os.Stat(pathStr)
	return err == nil && info.IsDir()
}
