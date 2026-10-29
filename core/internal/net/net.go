package net

import (
	"errors"
	"fullstackedorg/fullstacked/internal/frames"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/internal/tunnel"
	"fullstackedorg/fullstacked/types"
	"net"
	"strconv"
)

type NetFn = uint8

const (
	Connect NetFn = 0
)

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Connect:
		response.Type = types.CoreResponseStream

		host := "localhost"
		if len(data) > 1 && data[1].Type == types.STRING {
			host = data[1].Data.(string)
		}

		stream, err := createSocket(int(data[0].Data.(float64)), host)
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	}

	return errors.New("unknown net function")
}

// createSocket returns the socket's stream at once, it dials in its Open (see
// store.Dialing): connected, or an error ending the stream
func createSocket(
	port int,
	hostname string,
) (*types.ResponseStream, error) {
	tunnel := tunnel.FindTunnel(hostname)
	if tunnel != nil {
		return tunnel.Connect(), nil
	}

	address := net.JoinHostPort(hostname, strconv.Itoa(port))
	dialing := store.NewDialing[net.Conn]()

	stream := types.ResponseStream{
		Open: func(ctx *types.Context, streamId uint32) {
			go func() {
				socket, err := net.Dial("tcp", address)
				if err != nil {
					dialing.Failed()
					store.StreamError(ctx, streamId, err)
					return
				}

				// closed by the page while dialing
				if !dialing.Dialed(socket) {
					socket.Close()
					return
				}
				store.StreamSignal(ctx, streamId, frames.FlagConnected)

				buffer := make([]byte, store.ReadSize)
				for {
					n, err := socket.Read(buffer)

					if err != nil {
						socket.Close()
						store.StreamChunk(ctx, streamId, nil, true)
						return
					}

					store.StreamChunk(ctx, streamId, buffer[0:n], false)
				}
			}()
		},
		QueueWrites: true,
		Write: func(ctx *types.Context, streamId uint32, data []byte) {
			socket, ok := dialing.Wait()
			if !ok {
				return
			}
			_, err := socket.Write(data)
			if err != nil {
				// the read goroutine sees the closed socket and ends the stream
				socket.Close()
			}
		},
		TryWrite: func(ctx *types.Context, streamId uint32, data []byte) int {
			socket, ok := dialing.Ready()
			if !ok {
				return 0
			}
			n, err := tryWrite(socket, data)
			if err != nil {
				socket.Close()
				return len(data)
			}
			return n
		},
		Close: func(ctx *types.Context, streamId uint32) {
			if socket, ok := dialing.Close(); ok {
				socket.Close()
			}
		},
	}

	return &stream, nil
}
