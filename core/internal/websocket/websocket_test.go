package websocket

import (
	"context"
	"errors"
	"fullstackedorg/fullstacked/types"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

func TestWebSocketSwitch(t *testing.T) {
	var res types.CoreCallResponse
	header := types.CoreCallHeader{
		Fn: Connect,
	}

	// Missing URL
	data := []types.DeserializedData{}
	err := Switch(nil, header, data, &res)
	if err == nil {
		t.Fatal("expected error on missing url")
	}

	// Valid URL
	data = []types.DeserializedData{
		{Type: types.STRING, Data: "ws://localhost:9999"},
	}
	err = Switch(nil, header, data, &res)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if res.Type != types.CoreResponseStream {
		t.Fatalf("expected stream response, got %v", res.Type)
	}

	if res.Stream == nil {
		t.Fatal("expected non-nil stream")
	}
}

// serveMessage answers every connection with one text message of size bytes, then waits for the
// client to close and reports the close status it sent.
func serveMessage(t *testing.T, size int) (string, <-chan websocket.StatusCode) {
	status := make(chan websocket.StatusCode, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		c.SetReadLimit(-1)
		_ = c.Write(r.Context(), websocket.MessageText, []byte(strings.Repeat("x", size)))
		_, _, err = c.Read(r.Context())
		status <- websocket.CloseStatus(err)
	}))
	t.Cleanup(srv.Close)
	return "ws" + strings.TrimPrefix(srv.URL, "http"), status
}

func TestDialReadsMessagesFarAboveTheLibraryDefault(t *testing.T) {
	const size = 4_500_000 // a multi-megabyte JSON frame; coder/websocket alone caps at 32 KiB
	url, _ := serveMessage(t, size)
	c, err := dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	_, data, err := c.Read(context.Background())
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(data) != size {
		t.Fatalf("got %d bytes, want %d", len(data), size)
	}
}

func TestCloseInfoReportsOversizedMessagesAs1009(t *testing.T) {
	url, status := serveMessage(t, 64)
	c, err := dial(context.Background(), url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.CloseNow()
	c.SetReadLimit(16) // stands in for maxMessageSize
	_, _, err = c.Read(context.Background())
	code, reason := closeInfo(err)
	if code != 1009 || !strings.Contains(reason, "message too big") {
		t.Fatalf("closeInfo = %d %q, want 1009 with a reason", code, reason)
	}
	if got := <-status; got != websocket.StatusMessageTooBig {
		t.Fatalf("server saw close %d, want 1009", got)
	}
}

func TestCloseInfoKeepsPeerCloseCodesAndAbnormalDrops(t *testing.T) {
	code, reason := closeInfo(websocket.CloseError{Code: 4401, Reason: "token expired"})
	if code != 4401 || reason != "token expired" {
		t.Fatalf("peer close = %d %q", code, reason)
	}
	if code, _ := closeInfo(errors.New("connection reset")); code != 1006 {
		t.Fatalf("drop = %d, want 1006", code)
	}
}
