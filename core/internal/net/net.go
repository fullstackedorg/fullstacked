package net

import (
	"errors"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"net"
	"strconv"
)

type NetFn = uint8

const (
	Connect NetFn = 0
)

func Switch(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Connect:
		response.Type = types.CoreResponseStream
		stream, err := createSocket(int(data[0].Data.(float64)), data[1].Data.(string))
		if err != nil {
			return err
		}
		response.Stream = stream
		return nil
	}

	return errors.New("unknown net function")
}

func createSocket(
	port int,
	hostname string,
) (*types.ResponseStream, error) {
	socket, err := net.Dial("tcp", hostname+":"+strconv.Itoa(port))
	if err != nil {
		return nil, err
	}

	stream := types.ResponseStream{
		Open: func(ctx *types.CoreCallContext, streamId uint8) {
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
		Write: func(ctx *types.CoreCallContext, streamId uint8, data []byte) {
			socket.Write(data)
		},
		Close: func(ctx *types.CoreCallContext, streamId uint8) {
			socket.Close()
		},
	}

	return &stream, nil
}
