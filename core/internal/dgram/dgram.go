package dgram

import (
	"errors"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"net"
	"strconv"
)

type DgramFn = uint8

const (
	CreateSocket DgramFn = 0
)

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case CreateSocket:
		response.Type = types.CoreResponseStream

		network := "udp"
		if len(data) > 0 && data[0].Type == types.STRING {
			network = data[0].Data.(string)
		}

		port := 0
		if len(data) > 1 && data[1].Type == types.NUMBER {
			port = int(data[1].Data.(float64))
		}

		host := "0.0.0.0"
		if len(data) > 2 && data[2].Type == types.STRING {
			host = data[2].Data.(string)
		}

		stream, err := createSocket(network, host, port)
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	}

	return errors.New("unknown dgram function")
}

func createSocket(
	network string,
	hostname string,
	port int,
) (*types.ResponseStream, error) {
	addr, err := net.ResolveUDPAddr(network, net.JoinHostPort(hostname, strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}

	conn, err := net.ListenUDP(network, addr)
	if err != nil {
		return nil, err
	}

	stream := types.ResponseStream{
		Open: func(ctx *types.Context, streamId uint8) {
			go func() {
				// emit listening event
				boundAddr := conn.LocalAddr().(*net.UDPAddr)
				store.StreamEvent(ctx, streamId, "listening", []types.SerializableData{
					boundAddr.IP.String(),
					float64(boundAddr.Port),
				}, false)

				for {
					buffer := make([]byte, 65507) // max udp payload
					n, remoteAddr, err := conn.ReadFromUDP(buffer)

					if err != nil {
						store.StreamEvent(ctx, streamId, "error", []types.SerializableData{err.Error()}, false)
						store.StreamChunk(ctx, streamId, nil, true)
						return
					}

					store.StreamEvent(ctx, streamId, "message", []types.SerializableData{
						buffer[:n],
						remoteAddr.IP.String(),
						float64(remoteAddr.Port),
					}, false)
				}

			}()
		},
		Write: func(ctx *types.Context, streamId uint8, data []byte) {
			// Write interface implementation, no-op for generic send
		},
		WriteEvent: func(ctx *types.Context, streamId uint8, event string, data []types.DeserializedData) {
			if event == "send" && len(data) >= 3 {
				buffer := data[0].Data.([]byte)
				targetPort := int(data[1].Data.(float64))
				targetHost := data[2].Data.(string)

				targetAddr, err := net.ResolveUDPAddr(network, net.JoinHostPort(targetHost, strconv.Itoa(targetPort)))
				if err == nil {
					conn.WriteToUDP(buffer, targetAddr)
				}
			}
		},
		Close: func(ctx *types.Context, streamId uint8) {
			conn.Close()
		},
	}

	return &stream, nil
}
