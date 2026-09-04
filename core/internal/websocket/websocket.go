package websocket

import (
	"context"
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/internal/tunnel"
	"fullstackedorg/fullstacked/types"
	"net"
	"net/http"
	"sync"

	"github.com/coder/websocket"
)

type WebSocketFn = uint8

const (
	Connect WebSocketFn = 0
)

var httpClient = &http.Client{
	Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, _, err := net.SplitHostPort(addr)
			if err != nil {
				host = addr
			}

			t := tunnel.FindTunnel(host)
			if t != nil {
				return t.Dial(ctx)
			}

			var dialer net.Dialer
			return dialer.DialContext(ctx, network, addr)
		},
	},
}

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Connect:
		if len(data) == 0 || data[0].Data == nil {
			return errors.New("missing websocket url")
		}

		urlStr, ok := data[0].Data.(string)
		if !ok {
			return errors.New("websocket url must be string")
		}

		var protocols []string
		if len(data) > 1 && data[1].Data != nil {
			if data[1].Type == types.OBJECT {
				_ = json.Unmarshal(data[1].Data.(types.DeserializedRawObject).Data, &protocols)
			} else if data[1].Type == types.STRING {
				protocols = []string{data[1].Data.(string)}
			}
		}

		response.Type = types.CoreResponseStream
		response.Stream = createWebSocketStream(urlStr, protocols)
		return nil
	}

	return errors.New("unknown websocket function")
}

func createWebSocketStream(urlStr string, protocols []string) *types.ResponseStream {
	var wsConn *websocket.Conn
	var connMutex sync.Mutex
	var writeMutex sync.Mutex
	ctx, cancel := context.WithCancel(context.Background())

	return &types.ResponseStream{
		Open: func(coreCtx *types.Context, streamId uint8) {
			opts := &websocket.DialOptions{
				Subprotocols: protocols,
				HTTPClient:   httpClient,
			}

			c, _, err := websocket.Dial(ctx, urlStr, opts)
			if err != nil {
				store.StreamEvent(coreCtx, streamId, "error", []types.SerializableData{err.Error()}, false)
				store.StreamEvent(coreCtx, streamId, "close", []types.SerializableData{float64(1006), err.Error(), false}, true)
				return
			}

			connMutex.Lock()
			wsConn = c
			connMutex.Unlock()

			store.StreamEvent(coreCtx, streamId, "open", []types.SerializableData{c.Subprotocol()}, false)

			for {
				msgType, msgData, err := c.Read(ctx)
				if err != nil {
					code := int(websocket.CloseStatus(err))
					if code == -1 {
						code = 1006
					}
					reason := ""
					var closeErr websocket.CloseError
					if errors.As(err, &closeErr) {
						reason = closeErr.Reason
					}
					wasClean := code != 1006

					store.StreamEvent(coreCtx, streamId, "close", []types.SerializableData{float64(code), reason, wasClean}, true)
					return
				}

				if msgType == websocket.MessageText {
					store.StreamEvent(coreCtx, streamId, "message", []types.SerializableData{string(msgData), false}, false)
				} else {
					store.StreamEvent(coreCtx, streamId, "message", []types.SerializableData{msgData, true}, false)
				}
			}
		},
		WriteEvent: func(coreCtx *types.Context, streamId uint8, event string, data []types.DeserializedData) {
			connMutex.Lock()
			c := wsConn
			connMutex.Unlock()

			switch event {
			case "send":
				if c == nil || len(data) == 0 {
					return
				}
				isBinary := false
				if len(data) > 1 && data[1].Type == types.BOOLEAN {
					isBinary = data[1].Data.(bool)
				}

				writeMutex.Lock()
				var writeErr error
				if isBinary {
					var bytesData []byte
					if data[0].Type == types.BUFFER {
						bytesData = data[0].Data.([]byte)
					}
					writeErr = c.Write(ctx, websocket.MessageBinary, bytesData)
				} else {
					var text string
					if data[0].Type == types.STRING {
						text = data[0].Data.(string)
					}
					writeErr = c.Write(ctx, websocket.MessageText, []byte(text))
				}
				writeMutex.Unlock()

				if writeErr != nil {
					store.StreamEvent(coreCtx, streamId, "error", []types.SerializableData{writeErr.Error()}, false)
				}
			case "close":
				code := 1000
				reason := ""
				if len(data) > 0 && data[0].Type == types.NUMBER {
					code = int(data[0].Data.(float64))
				}
				if len(data) > 1 && data[1].Type == types.STRING {
					reason = data[1].Data.(string)
				}
				if c == nil {
					cancel()
					return
				}
				c.Close(websocket.StatusCode(code), reason)
			}
		},
		Close: func(coreCtx *types.Context, streamId uint8) {
			cancel()
			connMutex.Lock()
			c := wsConn
			connMutex.Unlock()
			if c != nil {
				c.CloseNow()
			}
		},
	}
}
