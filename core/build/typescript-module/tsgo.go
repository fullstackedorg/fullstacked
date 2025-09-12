package tsgo

import (
	"fmt"
	"io"
	"os"
	"runtime"

	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/lsp"
	"github.com/microsoft/typescript-go/internal/tspath"
	"github.com/microsoft/typescript-go/internal/vfs/osvfs"
)

func RunLSP(
	directory string,
	in *io.PipeReader, 
	out *io.PipeWriter,
) int {
	fs := bundled.WrapFS(osvfs.FS())
	defaultLibraryPath := bundled.LibPath()
	typingsLocation := getGlobalTypingsCacheLocation()

	s := lsp.NewServer(&lsp.ServerOptions{
		In:                 lsp.ToReader(in),
		Out:                lsp.ToWriter(out),
		Err:                os.Stderr,
		Cwd:                directory,
		FS:                 fs,
		DefaultLibraryPath: defaultLibraryPath,
		TypingsLocation:    typingsLocation,
	})

	if err := s.Run(); err != nil {

		fmt.Println(err)
		// return 1
	}

	fmt.Println("LSP OUT")
	return 0
}

func getGlobalTypingsCacheLocation() string {
	switch runtime.GOOS {
	case "windows":
		return tspath.CombinePaths(tspath.CombinePaths(getWindowsCacheLocation(), "Microsoft/TypeScript"), core.VersionMajorMinor())
	case "openbsd", "freebsd", "netbsd", "darwin", "linux", "android":
		return tspath.CombinePaths(tspath.CombinePaths(getNonWindowsCacheLocation(), "typescript"), core.VersionMajorMinor())
	default:
		panic("unsupported platform: " + runtime.GOOS)
	}
}

func getWindowsCacheLocation() string {
	basePath, err := os.UserCacheDir()
	if err != nil {
		if basePath, err = os.UserConfigDir(); err != nil {
			if basePath, err = os.UserHomeDir(); err != nil {
				if userProfile := os.Getenv("USERPROFILE"); userProfile != "" {
					basePath = userProfile
				} else if homeDrive, homePath := os.Getenv("HOMEDRIVE"), os.Getenv("HOMEPATH"); homeDrive != "" && homePath != "" {
					basePath = homeDrive + homePath
				} else {
					basePath = os.TempDir()
				}
			}
		}
	}
	return basePath
}

func getNonWindowsCacheLocation() string {
	if xdgCacheHome := os.Getenv("XDG_CACHE_HOME"); xdgCacheHome != "" {
		return xdgCacheHome
	}
	const platformIsDarwin = runtime.GOOS == "darwin"
	var usersDir string
	if platformIsDarwin {
		usersDir = "Users"
	} else {
		usersDir = "home"
	}
	homePath, err := os.UserHomeDir()
	if err != nil {
		if home := os.Getenv("HOME"); home != "" {
			homePath = home
		} else {
			var userName string
			if logName := os.Getenv("LOGNAME"); logName != "" {
				userName = logName
			} else if user := os.Getenv("USER"); user != "" {
				userName = user
			}
			if userName != "" {
				homePath = "/" + usersDir + "/" + userName
			} else {
				homePath = os.TempDir()
			}
		}
	}
	var cacheFolder string
	if platformIsDarwin {
		cacheFolder = "Library/Caches"
	} else {
		cacheFolder = ".cache"
	}
	return tspath.CombinePaths(homePath, cacheFolder)
}
