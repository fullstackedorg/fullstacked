package tsgo

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"runtime"
	"syscall"

	"github.com/microsoft/typescript-go/internal/bundled"
	"github.com/microsoft/typescript-go/internal/core"
	"github.com/microsoft/typescript-go/internal/lsp"
	"github.com/microsoft/typescript-go/internal/tspath"
	"github.com/microsoft/typescript-go/internal/vfs"
	"github.com/microsoft/typescript-go/internal/vfs/osvfs"
)

type (
	FsEntries     = vfs.Entries
	FsFileInfo    = vfs.FileInfo
	FsWalkDirFunc = vfs.WalkDirFunc
)

func Version() string {
	return core.Version()
}

func RunLSP(
	directory string,
	in *io.PipeReader,
	out *io.PipeWriter,
	end chan struct{},
) {
	runLSP(
		osvfs.FS(),
		directory,
		in,
		out,
		end,
	)
}

func RunLSP_WASM(
	suppliedFS vfs.FS,
	directory string,
	in *io.PipeReader,
	out *io.PipeWriter,
	end chan struct{},
) {
	runLSP(
		suppliedFS,
		directory,
		in,
		out,
		end,
	)
}

func runLSP(
	suppliedFS vfs.FS,
	directory string,
	in *io.PipeReader,
	out *io.PipeWriter,
	end chan struct{},
) {
	fs := bundled.WrapFS(suppliedFS)
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
		NpmInstall: func(cwd string, args []string) ([]byte, error) {
			return nil, nil
		},
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	fmt.Println("LSP START")
	if err := s.Run(ctx); err != nil {
		if err.Error() == "context canceled" {
			os.Exit(0)
		} else {
			fmt.Println(err)
		}
	}
	close(end)
	out.Write([]byte{})
	fmt.Println("LSP END")
}

func getGlobalTypingsCacheLocation() string {
	switch runtime.GOOS {
	case "windows":
		return tspath.CombinePaths(tspath.CombinePaths(getWindowsCacheLocation(), "Microsoft/TypeScript"), core.VersionMajorMinor())
	case "openbsd", "freebsd", "netbsd", "darwin", "linux", "android", "ios", "js":
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
