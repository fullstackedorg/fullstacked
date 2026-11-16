package git

import (
	"errors"
	nethttp "net/http"
	"net/http/httptest"
	"testing"

	git "github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/config"
	"github.com/go-git/go-git/v6/storage/memory"
)

// The errors go-git returns for a refused ls-refs, per HTTP status: 401 and 403 both re-ask the
// git-auth plugin (a 403 is what a client gets after switching to another account while the
// previous account's token is still cached), other failures do not.
func TestErrNeedsFreshAuth(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   bool
	}{
		{nethttp.StatusUnauthorized, true},
		{nethttp.StatusForbidden, true},
		{nethttp.StatusNotFound, false},
		{nethttp.StatusInternalServerError, false},
	} {
		srv := httptest.NewServer(nethttp.HandlerFunc(func(w nethttp.ResponseWriter, _ *nethttp.Request) {
			nethttp.Error(w, "refused", tc.status)
		}))
		remote := git.NewRemote(memory.NewStorage(), &config.RemoteConfig{
			Name: "origin",
			URLs: []string{srv.URL + "/owner/repo.git"},
		})
		_, err := remote.List(&git.ListOptions{})
		srv.Close()
		if err == nil {
			t.Fatalf("status %d: expected an error", tc.status)
		}
		if got := errNeedsFreshAuth(err); got != tc.want {
			t.Errorf("status %d: errNeedsFreshAuth(%q) = %v, want %v", tc.status, err, got, tc.want)
		}
	}

	if errNeedsFreshAuth(nil) {
		t.Error("errNeedsFreshAuth(nil) = true")
	}
	if errNeedsFreshAuth(errors.New("repository not found")) {
		t.Error("errNeedsFreshAuth(not found) = true")
	}
}
