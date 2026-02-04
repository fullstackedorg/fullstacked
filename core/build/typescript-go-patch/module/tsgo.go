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

	fmt.Println("LSP START for", directory)
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
	cacheDir, err := os.UserCacheDir()
	if err != nil {
		cacheDir = os.TempDir()
	}

	var subdir string
	if runtime.GOOS == "windows" {
		subdir = "Microsoft/TypeScript"
	} else {
		subdir = "typescript"
	}
	return tspath.CombinePaths(cacheDir, subdir, core.VersionMajorMinor())
}
