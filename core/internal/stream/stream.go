package stream

import (
	"errors"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
)

type StreamFn = uint8

const (
	Open  StreamFn = 0
	Write StreamFn = 1
	Close StreamFn = 2
)

func Switch(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	err := (error)(nil)
	streamId := uint8(data[0].Data.(float64))

	switch header.Fn {
	case Open:
		err = openStream(ctx, streamId)
	case Write:
		err = writeStream(ctx, streamId, data[1].Data.([]byte))
	case Close:
		err = closeStream(ctx, streamId)
	default:
		return errors.New("unknown stream function")
	}

	if err != nil {
		return err
	}

	response.Type = types.CoreResponseData

	return nil
}

func openStream(ctx *types.CoreCallContext, streamId uint8) error {
	ctx.StreamsMutex.Lock()
	stream, ok := ctx.Streams[streamId]
	ctx.StreamsMutex.Unlock()

	if !ok {
		return errors.New("no stream for id")
	}

	if stream.Opened {
		return errors.New("stream already opened")
	}

	stream.Opened = true

	if stream.Open != nil {
		go stream.Open(ctx, streamId)
	}

	return nil
}

func writeStream(ctx *types.CoreCallContext, streamId uint8, data []byte) error {
	ctx.StreamsMutex.Lock()
	stream, ok := ctx.Streams[streamId]
	ctx.StreamsMutex.Unlock()

	if !ok {
		return errors.New("no stream for id")
	}

	if !stream.Opened {
		return errors.New("stream is not opened")
	}

	if stream.Write == nil {
		return errors.New("stream has no write function")
	}

	stream.Write(ctx, streamId, data)

	return nil
}

func closeStream(ctx *types.CoreCallContext, streamId uint8) error {
	ctx.StreamsMutex.Lock()
	stream, ok := ctx.Streams[streamId]
	ctx.StreamsMutex.Unlock()

	if !ok {
		return errors.New("no stream for id")
	}

	if stream.Close != nil {
		stream.Close(ctx, streamId)
	}

	store.StreamChunk(ctx, streamId, nil, true)

	return nil
}
