package websocket

import (
	"fullstackedorg/fullstacked/types"
	"testing"
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
