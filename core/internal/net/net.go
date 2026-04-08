package net

import (
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"net"
	"strconv"
)

type NetFn = uint8

const (
	Connect        NetFn = 0
	RegisterTunnel NetFn = 1
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
	case RegisterTunnel:
		response.Type = types.CoreResponseData

		tunnel := Tunnel{}
		err := json.Unmarshal(data[0].Data.(types.DeserializedRawObject).Data, &tunnel)

		if err != nil {
			return err
		}

		RegisterTunnelFn(tunnel)

		return nil
	}

	return errors.New("unknown net function")
}

func createSocket(
	port int,
	hostname string,
) (*types.ResponseStream, error) {
	tunnel := findTunnel(hostname)
	if tunnel != nil {
		return tunnel.Connect()
	}

	socket, err := net.Dial("tcp", hostname+":"+strconv.Itoa(port))
	if err != nil {
		return nil, err
	}

	stream := types.ResponseStream{
		Open: func(ctx *types.Context, streamId uint8) {
			go func() {
				for {
					buffer := make([]byte, 1024)
					n, err := socket.Read(buffer)

					if err != nil {
						store.StreamChunk(ctx, streamId, nil, true)
						return
					}

					store.StreamChunk(ctx, streamId, buffer[0:n], false)
				}

			}()
		},
		Write: func(ctx *types.Context, streamId uint8, data []byte) {
			socket.Write(data)
		},
		Close: func(ctx *types.Context, streamId uint8) {
			socket.Close()
		},
	}

	return &stream, nil
}
