package git

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	git "github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/config"
	"github.com/go-git/go-git/v6/plumbing/object"

	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
)

func TestPullPushAlreadyUpToDate(t *testing.T) {
	// 1. Create a remote bare repository.
	remoteDir, err := os.MkdirTemp("", "git-remote-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(remoteDir)

	_, err = git.PlainInit(remoteDir, true)
	if err != nil {
		t.Fatalf("failed to init remote repo: %v", err)
	}

	// 2. Create a local workspace, commit a file, and push to remote.
	initLocalDir, err := os.MkdirTemp("", "git-init-local-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(initLocalDir)

	initRepo, err := git.PlainInit(initLocalDir, false)
	if err != nil {
		t.Fatalf("failed to init local repo: %v", err)
	}

	w, err := initRepo.Worktree()
	if err != nil {
		t.Fatalf("failed to get worktree: %v", err)
	}

	dummyFile := filepath.Join(initLocalDir, "dummy.txt")
	if err := os.WriteFile(dummyFile, []byte("hello"), 0644); err != nil {
		t.Fatalf("failed to write dummy file: %v", err)
	}

	_, err = w.Add("dummy.txt")
	if err != nil {
		t.Fatalf("failed to add file: %v", err)
	}

	_, err = w.Commit("Initial commit", &git.CommitOptions{
		Author: &object.Signature{
			Name:  "Test",
			Email: "test@example.com",
			When:  time.Now(),
		},
	})
	if err != nil {
		t.Fatalf("failed to commit: %v", err)
	}

	head, err := initRepo.Head()
	if err != nil {
		t.Fatalf("failed to get head: %v", err)
	}
	branchName := head.Name().Short()

	_, err = initRepo.CreateRemote(&config.RemoteConfig{
		Name: "origin",
		URLs: []string{remoteDir},
	})
	if err != nil {
		t.Fatalf("failed to create remote: %v", err)
	}

	err = initRepo.Push(&git.PushOptions{
		RemoteName: "origin",
	})
	if err != nil {
		t.Fatalf("failed to push initial commit: %v", err)
	}

	// 3. Clone to localDir.
	localDir, err := os.MkdirTemp("", "git-local-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(localDir)

	_, err = git.PlainClone(localDir, &git.CloneOptions{
		URL: remoteDir,
	})
	if err != nil {
		t.Fatalf("failed to clone: %v", err)
	}

	// 4. Setup mock Context.
	ctxId := store.NewContext(localDir, localDir)
	ctx := store.Contexts[ctxId]
	if ctx == nil {
		t.Fatalf("failed to create store context")
	}
	defer store.EndContext(ctxId)

	// Mock OnStreamData to prevent panics in StreamError / StreamChunk
	oldOnStreamData := store.OnStreamData
	store.OnStreamData = func(ctxId uint8, streamId uint8, size int) {}
	defer func() {
		store.OnStreamData = oldOnStreamData
	}()

	// Register stream 1 in the context
	storedStream := &types.StoredStream{
		Opened: true,
		Close:  func(ctx *types.Context, streamId uint8) {},
	}
	ctx.StreamsMutex.Lock()
	ctx.Streams[1] = storedStream
	ctx.StreamsMutex.Unlock()

	// 5. Test Pull (already up to date).
	pullStream, err := pull(localDir, "")
	if err != nil {
		t.Fatalf("pull failed to initialize: %v", err)
	}

	pullStream.Open(ctx, 1)

	if storedStream.Error != nil {
		t.Errorf("pull returned unexpected error: %v", storedStream.Error)
	}
	if !storedStream.Ended {
		t.Errorf("pull stream did not end")
	}

	// Reset stored stream status
	ctx.StreamsMutex.Lock()
	storedStream.Error = nil
	storedStream.Ended = false
	ctx.StreamsMutex.Unlock()

	// 6. Test Push (already up to date).
	pushStream, err := push(localDir, "")
	if err != nil {
		t.Fatalf("push failed to initialize: %v", err)
	}

	pushStream.Open(ctx, 1)

	if storedStream.Error != nil {
		t.Errorf("push returned unexpected error: %v", storedStream.Error)
	}
	if !storedStream.Ended {
		t.Errorf("push stream did not end")
	}

	// 7. Test FetchBranch (already up to date).
	dir, err := OpenGitDirectory(localDir)
	if err != nil {
		t.Fatalf("failed to open git directory: %v", err)
	}
	defer dir.Close()

	progress := &GitStream{
		ctx:      ctx,
		streamId: 1,
	}
	err = dir.FetchBranch(branchName, progress)
	if err != nil {
		t.Errorf("FetchBranch returned unexpected error: %v", err)
	}
}
