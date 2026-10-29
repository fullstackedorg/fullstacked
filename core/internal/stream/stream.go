package stream

import (
	"errors"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
)

type StreamFn = uint8

const (
	Open       StreamFn = 0
	Write      StreamFn = 1
	WriteEvent StreamFn = 2
	Close      StreamFn = 3
)

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	err := (error)(nil)
	streamId := uint32(data[0].Data.(float64))

	switch header.Fn {
	case Open:
		err = openStream(ctx, streamId)
	case Write:
		var wait bool
		wait, err = writeStream(ctx, streamId, data[1].Data.([]byte))
		// queued writes past the high water mark: the page waits for a drain
		if wait {
			response.Data = true
		}
	case WriteEvent:
		dataArgs := []types.DeserializedData{}
		if len(data) > 2 {
			dataArgs = data[2:]
		}
		err = writeEventStream(ctx, streamId, data[1].Data.(string), dataArgs)
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

func openStream(ctx *types.Context, streamId uint32) error {
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

func writeStream(ctx *types.Context, streamId uint32, data []byte) (bool, error) {
	ctx.StreamsMutex.Lock()
	stream, ok := ctx.Streams[streamId]
	ctx.StreamsMutex.Unlock()

	if !ok {
		return false, nil
	}

	if !stream.Opened {
		return false, errors.New("stream is not opened")
	}

	if stream.Write == nil {
		return false, errors.New("stream has no write function")
	}

	if stream.Writes != nil {
		return store.QueueWrite(ctx, streamId, stream, data), nil
	}

	stream.Write(ctx, streamId, data)

	return false, nil
}

func writeEventStream(ctx *types.Context, streamId uint32, event string, data []types.DeserializedData) error {
	ctx.StreamsMutex.Lock()
	stream, ok := ctx.Streams[streamId]
	ctx.StreamsMutex.Unlock()

	if !ok {
		return nil
	}

	if !stream.Opened {
		return errors.New("stream is not opened")
	}

	if stream.WriteEvent == nil {
		return errors.New("stream has no write event function")
	}

	stream.WriteEvent(ctx, streamId, event, data)

	return nil
}

func closeStream(ctx *types.Context, streamId uint32) error {
	store.CloseStream(ctx, streamId)
	return nil
}
