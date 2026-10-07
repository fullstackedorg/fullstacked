package git

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	git "github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/config"
	"github.com/go-git/go-git/v6/plumbing"
	"github.com/go-git/go-git/v6/plumbing/object"

	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
)

var testSignature = &object.Signature{Name: "Test", Email: "test@example.com", When: time.Now()}

func commitFile(t *testing.T, repo *git.Repository, dir string, content string) plumbing.Hash {
	t.Helper()
	w, err := repo.Worktree()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "file.txt"), []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Add("file.txt"); err != nil {
		t.Fatal(err)
	}
	hash, err := w.Commit(content, &git.CommitOptions{Author: testSignature})
	if err != nil {
		t.Fatal(err)
	}
	return hash
}

func mockStreamContext(t *testing.T, dir string) (*types.Context, *types.StoredStream) {
	t.Helper()
	ctxId := store.NewContext(dir, dir, false, "")
	ctx := store.Contexts[ctxId]
	t.Cleanup(func() { store.EndContext(ctxId) })

	oldOnStreamData := store.OnStreamData
	store.OnStreamData = func(ctxId uint8, streamId uint8, size int) {}
	t.Cleanup(func() { store.OnStreamData = oldOnStreamData })

	stream := &types.StoredStream{Opened: true, Close: func(ctx *types.Context, streamId uint8) {}}
	ctx.StreamsMutex.Lock()
	ctx.Streams[1] = stream
	ctx.StreamsMutex.Unlock()
	return ctx, stream
}

func runStream(t *testing.T, ctx *types.Context, stream *types.StoredStream, s *types.ResponseStream) error {
	t.Helper()
	ctx.StreamsMutex.Lock()
	stream.Error = nil
	stream.Ended = false
	ctx.StreamsMutex.Unlock()
	s.Open(ctx, 1)
	if stream.Error == nil && !stream.Ended {
		t.Fatalf("stream neither ended nor errored")
	}
	if stream.Error != nil {
		return stream.Error.(error)
	}
	return nil
}

// Tags created on the remote after cloning (annotated or lightweight) must be
// fetched and checked out at the commit they point to.
func TestCheckoutTagsCreatedAfterClone(t *testing.T) {
	remoteDir := t.TempDir()
	if _, err := git.PlainInit(remoteDir, true); err != nil {
		t.Fatal(err)
	}

	authorDir := t.TempDir()
	authorRepo, err := git.PlainInit(authorDir, false)
	if err != nil {
		t.Fatal(err)
	}
	first := commitFile(t, authorRepo, authorDir, "v1")
	if _, err := authorRepo.CreateRemote(&config.RemoteConfig{Name: "origin", URLs: []string{remoteDir}}); err != nil {
		t.Fatal(err)
	}
	if err := authorRepo.Push(&git.PushOptions{RemoteName: "origin"}); err != nil {
		t.Fatal(err)
	}

	localDir := t.TempDir()
	if _, err := git.PlainClone(localDir, &git.CloneOptions{URL: remoteDir}); err != nil {
		t.Fatal(err)
	}

	second := commitFile(t, authorRepo, authorDir, "v2")
	if _, err := authorRepo.CreateTag("v1.0.0", first, &git.CreateTagOptions{Tagger: testSignature, Message: "v1.0.0"}); err != nil {
		t.Fatal(err)
	}
	if _, err := authorRepo.CreateTag("light", second, nil); err != nil {
		t.Fatal(err)
	}
	if err := authorRepo.Push(&git.PushOptions{
		RemoteName: "origin",
		RefSpecs:   []config.RefSpec{"refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"},
	}); err != nil {
		t.Fatal(err)
	}

	ctx, stream := mockStreamContext(t, localDir)

	for tag, want := range map[string]plumbing.Hash{"v1.0.0": first, "light": second} {
		s, err := checkout(localDir, tag, false, "")
		if err != nil {
			t.Fatal(err)
		}
		if err := runStream(t, ctx, stream, s); err != nil {
			t.Fatalf("checkout %s: %v", tag, err)
		}
		head, err := HeadFn(localDir)
		if err != nil {
			t.Fatal(err)
		}
		if head.Hash != want.String() {
			t.Errorf("checkout %s: HEAD is %s, want commit %s", tag, head.Hash, want)
		}
		content, _ := os.ReadFile(filepath.Join(localDir, "file.txt"))
		if wantContent := map[string]string{"v1.0.0": "v1", "light": "v2"}[tag]; string(content) != wantContent {
			t.Errorf("checkout %s: file.txt is %q, want %q", tag, content, wantContent)
		}
	}

	s, err := checkout(localDir, "does-not-exist", false, "")
	if err != nil {
		t.Fatal(err)
	}
	if runStream(t, ctx, stream, s) == nil {
		t.Errorf("checkout of an unknown ref should fail")
	}
}

// fetch brings branches and tags pushed after the clone without moving HEAD.
func TestFetchAll(t *testing.T) {
	remoteDir := t.TempDir()
	if _, err := git.PlainInit(remoteDir, true); err != nil {
		t.Fatal(err)
	}
	authorDir := t.TempDir()
	authorRepo, err := git.PlainInit(authorDir, false)
	if err != nil {
		t.Fatal(err)
	}
	first := commitFile(t, authorRepo, authorDir, "v1")
	if _, err := authorRepo.CreateRemote(&config.RemoteConfig{Name: "origin", URLs: []string{remoteDir}}); err != nil {
		t.Fatal(err)
	}
	if err := authorRepo.Push(&git.PushOptions{RemoteName: "origin"}); err != nil {
		t.Fatal(err)
	}
	localDir := t.TempDir()
	if _, err := git.PlainClone(localDir, &git.CloneOptions{URL: remoteDir}); err != nil {
		t.Fatal(err)
	}

	second := commitFile(t, authorRepo, authorDir, "v2")
	if _, err := authorRepo.CreateTag("v2.0.0", second, &git.CreateTagOptions{Tagger: testSignature, Message: "v2"}); err != nil {
		t.Fatal(err)
	}
	if err := authorRepo.Push(&git.PushOptions{
		RemoteName: "origin",
		RefSpecs:   []config.RefSpec{"refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"},
	}); err != nil {
		t.Fatal(err)
	}

	ctx, stream := mockStreamContext(t, localDir)
	if err := runStream(t, ctx, stream, fetch(localDir, "")); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	// a second fetch is already up to date and must not fail
	if err := runStream(t, ctx, stream, fetch(localDir, "")); err != nil {
		t.Fatalf("second fetch: %v", err)
	}

	repo, err := git.PlainOpen(localDir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Tag("v2.0.0"); err != nil {
		t.Errorf("tag v2.0.0 was not fetched: %v", err)
	}
	head, _ := repo.Head()
	if head.Hash() != first {
		t.Errorf("fetch moved HEAD to %s", head.Hash())
	}
	branch := head.Name().Short()
	remoteRef, err := repo.Reference(plumbing.NewRemoteReferenceName("origin", branch), true)
	if err != nil || remoteRef.Hash() != second {
		t.Errorf("origin/%s not updated: %v", branch, err)
	}
}
