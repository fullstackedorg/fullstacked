package tunnel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"fullstackedorg/fullstacked/internal/frames"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/internal/utils"
	"fullstackedorg/fullstacked/types"
	"net"
	"net/url"
	"strconv"
	"sync"
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

	// the tunnel's sessions to the hub (pool.go)
	pool *pool
}

var tunnels = []*Tunnel{}
var tunnelsMutex sync.Mutex

func RegisterTunnelFn(tunnel Tunnel) (string, error) {
	if tunnel.Host == "" {
		return "", errors.New("host is required")
	}

	if tunnel.Name == "" {
		tunnel.Name, _ = utils.RandomAlpha(8)
	}

	if tunnel.Port == 0 {
		if tunnel.Unsecure {
			tunnel.Port = 80
		} else {
			tunnel.Port = 443
		}
	}

	tunnelsMutex.Lock()
	defer tunnelsMutex.Unlock()

	existing := findTunnelLocked(tunnel.Name)

	if existing != nil {
		same := existing.Host == tunnel.Host && existing.Port == tunnel.Port &&
			existing.Path == tunnel.Path && existing.Unsecure == tunnel.Unsecure &&
			existing.Authorization == tunnel.Authorization
		if same {
			existing.pool.warm()
			return tunnel.Name, nil
		}
		// another hub or credential: new sessions, the old ones close once
		// their streams end
		existing.pool.stop()
		existing.Host = tunnel.Host
		existing.Port = tunnel.Port
		existing.Path = tunnel.Path
		existing.Unsecure = tunnel.Unsecure
		existing.Authorization = tunnel.Authorization
		existing.pool = newPool(existing)
		existing.pool.warm()
	} else {
		t := tunnel
		t.pool = newPool(&t)
		tunnels = append(tunnels, &t)
		t.pool.warm()
	}

	return tunnel.Name, nil
}

func FindTunnel(name string) *Tunnel {
	tunnelsMutex.Lock()
	defer tunnelsMutex.Unlock()
	return findTunnelLocked(name)
}

func findTunnelLocked(name string) *Tunnel {
	for _, t := range tunnels {
		if t.Name == name {
			return t
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

// Connect returns the stream of a connection through the tunnel at once: a
// stream on one of the tunnel's sessions (pool.go), opened in its Open (see
// store.Dialing): connected once the hub dialed the target, or an error
// ending the stream (the hub's reason, e.g. target_unreachable)
func (tunnel *Tunnel) Connect() *types.ResponseStream {
	name := tunnel.Name
	p := tunnel.pool

	dialing := store.NewDialing[*muxStream]()

	return &types.ResponseStream{
		Open: func(ctx *types.Context, streamId uint32) {
			go func() {
				stream, err := p.open(context.Background())
				if err == nil {
					err = stream.Opened(nil)
				}
				if err != nil {
					if stream != nil {
						stream.Close()
					}
					dialing.Failed()
					store.StreamError(ctx, streamId, fmt.Errorf("tunnel %s: %w", name, err))
					return
				}

				// closed by the page while opening
				if !dialing.Dialed(stream) {
					stream.Close()
					return
				}
				store.StreamSignal(ctx, streamId, frames.FlagConnected)

				buffer := make([]byte, store.ReadSize)
				for {
					n, err := stream.Read(buffer)
					if n > 0 {
						store.StreamChunk(ctx, streamId, append([]byte(nil), buffer[:n]...), false)
					}
					if err != nil {
						store.StreamChunk(ctx, streamId, nil, true)
						return
					}
				}
			}()
		},
		QueueWrites: true,
		Write: func(ctx *types.Context, streamId uint32, data []byte) {
			stream, ok := dialing.Wait()
			if !ok {
				return
			}
			if _, err := stream.Write(data); err != nil {
				// the read goroutine sees the closed stream and ends it
				stream.Close()
			}
		},
		Close: func(ctx *types.Context, streamId uint32) {
			if stream, ok := dialing.Close(); ok {
				stream.Close()
			}
		},
	}
}

// Dial returns a connection through the tunnel (fetch, git, WebSocket):
// a stream on one of its sessions, once the hub dialed the target
func (tunnel *Tunnel) Dial(ctx context.Context) (net.Conn, error) {
	stream, err := tunnel.pool.open(ctx)
	if err != nil {
		return nil, fmt.Errorf("tunnel %s: %w", tunnel.Name, err)
	}
	if err := stream.Opened(ctx.Done()); err != nil {
		stream.Close()
		return nil, fmt.Errorf("tunnel %s: %w", tunnel.Name, err)
	}
	return stream, nil
}
