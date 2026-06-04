package tunnel

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"net"
	"net/http"
	"net/url"
	"strconv"

	"github.com/coder/websocket"
)

type TunnelFn = uint8

const (
	Register TunnelFn = 0
)

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Register:
		response.Type = types.CoreResponseData

		tunnel := Tunnel{}
		err := json.Unmarshal(data[0].Data.(types.DeserializedRawObject).Data, &tunnel)

		if err != nil {
			return err
		}

		name, err := RegisterTunnelFn(tunnel)
		if err != nil {
			return err
		}

		response.Data = name

		return nil
	}

	return errors.New("unknown net function")
}

type Tunnel struct {
	Name          string `json:"name,omitempty"`
	Host          string `json:"host"`
	Port          int    `json:"port,omitempty"`
	Path          string `json:"path,omitempty"`
	Unsecure      bool   `json:"unsecure,omitempty"`
	Authorization string `json:"authorization,omitempty"`
}

var tunnels = []Tunnel{}

func RegisterTunnelFn(tunnel Tunnel) (string, error) {
	if tunnel.Host == "" {
		return "", errors.New("host is required")
	}

	if tunnel.Name == "" {
		tunnel.Name = rand.Text()
	}

	if tunnel.Port == 0 {
		if tunnel.Unsecure {
			tunnel.Port = 80
		} else {
			tunnel.Port = 443
		}
	}

	existing := FindTunnel(tunnel.Name)

	if existing != nil {
		existing.Host = tunnel.Host
		existing.Port = tunnel.Port
		existing.Path = tunnel.Path
		existing.Unsecure = tunnel.Unsecure
		existing.Authorization = tunnel.Authorization
	} else {
		tunnels = append(tunnels, tunnel)
	}

	return tunnel.Name, nil
}

func FindTunnel(name string) *Tunnel {
	for i, t := range tunnels {
		if t.Name == name {
			return &tunnels[i]
		}
	}
	return nil
}

func (tunnel *Tunnel) url() string {
	url := url.URL{}

	url.Scheme = "wss"
	if tunnel.Unsecure {
		url.Scheme = "ws"
	}

	url.Host = tunnel.Host

	if tunnel.Port != 0 {
		url.Host = tunnel.Host + ":" + strconv.Itoa(tunnel.Port)
	}

	url.Path = tunnel.Path

	return url.String()
}

func (tunnel *Tunnel) Connect() (*types.ResponseStream, error) {
	HTTPHeaders := http.Header{}
	if tunnel.Authorization != "" {
		HTTPHeaders["Authorization"] = []string{tunnel.Authorization}
	}

	c, _, err := websocket.Dial(context.Background(), tunnel.url(), &websocket.DialOptions{
		HTTPHeader: HTTPHeaders,
	})

	if err != nil {
		return nil, err
	}

	stream := types.ResponseStream{
		Open: func(ctx *types.Context, streamId uint8) {
			go func() {
				for {
					_, data, err := c.Read(context.Background())

					if err != nil {
						store.StreamChunk(ctx, streamId, nil, true)
						return
					}

					store.StreamChunk(ctx, streamId, data, false)
				}
			}()
		},
		Write: func(ctx *types.Context, streamId uint8, data []byte) {
			c.Write(context.Background(), websocket.MessageBinary, data)
		},
		Close: func(ctx *types.Context, streamId uint8) {
			c.CloseNow()
		},
	}

	return &stream, nil
}

func (tunnel *Tunnel) Dial(ctx context.Context) (net.Conn, error) {
	HTTPHeaders := http.Header{}
	if tunnel.Authorization != "" {
		HTTPHeaders["Authorization"] = []string{tunnel.Authorization}
	}

	c, _, err := websocket.Dial(ctx, tunnel.url(), &websocket.DialOptions{
		HTTPHeader: HTTPHeaders,
	})

	if err != nil {
		return nil, err
	}

	return websocket.NetConn(ctx, c, websocket.MessageBinary), nil
}
