package test

import (
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"sync/atomic"
	"time"
)

type TestFn = uint8

const (
	Hello              TestFn = 0
	Serialization      TestFn = 1
	SerializationIndex TestFn = 2
	Stream             TestFn = 3
	StreamWrite        TestFn = 4
	EventEmitter       TestFn = 5
	Panic              TestFn = 6
	BenchEcho          TestFn = 7
	BenchStream        TestFn = 8
)

type TestObject struct {
	Foo string `json:"foo"`
}

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Hello:
		response.Type = types.CoreResponseData
		response.Data = "Hello from go"
		return nil
	case Serialization:
		response.Type = types.CoreResponseData
		response.Data = testDataCheck(data[0])
		return nil
	case SerializationIndex:
		if len(data) < 2 {
			return errors.New("missing data")
		}

		testDataIndex := int(data[0].Data.(float64)) + 1

		response.Type = types.CoreResponseData
		response.Data = testDataCheck(data[testDataIndex])
		return nil
	case Stream:
		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				streamTest(
					ctx,
					streamId,
					data[0].Data.([]byte),
					data[1].Data.(float64),
					data[2].Data.(bool),
				)
			},
		}
		return nil
	case StreamWrite:
		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Write: func(ctx *types.Context, streamId uint8, data []byte) {
				store.StreamChunk(ctx, streamId, data, false)
			},
		}
		return nil
	case EventEmitter:
		response.Type = types.CoreResponseStream

		intervalMs := data[0].Data.(float64)

		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				for i, d := range data {
					if i == 0 {
						continue
					}

					eventData := d.Data

					if d.Type == types.OBJECT {
						eventData = TestObject{}
						json.Unmarshal(d.Data.(types.DeserializedRawObject).Data, &eventData)
					}

					time.Sleep(time.Millisecond * time.Duration(intervalMs))
					store.StreamEvent(ctx, streamId, "event", []types.SerializableData{eventData}, i == len(data)-1)
				}
			},
		}
		return nil
	case Panic:
		panic(data[0].Data.(string))
	case BenchEcho:
		// no argument acts as a noop
		response.Type = types.CoreResponseData
		if len(data) > 0 {
			response.Data = data[0].Data
		}
		return nil
	case BenchStream:
		if len(data) < 2 || data[0].Type != types.NUMBER || data[1].Type != types.NUMBER {
			return errors.New("bench stream requires total and chunk size")
		}

		total := int(data[0].Data.(float64))
		chunkSize := int(data[1].Data.(float64))
		if total < 0 || chunkSize <= 0 {
			return errors.New("bench stream requires total >= 0 and chunk size > 0")
		}

		closed := atomic.Bool{}

		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				benchStream(ctx, streamId, total, chunkSize, &closed)
			},
			Close: func(ctx *types.Context, streamId uint8) {
				closed.Store(true)
			},
		}
		return nil
	}

	return errors.New("unknown test function")
}

func testDataCheck(testData types.DeserializedData) types.DeserializedData {
	switch testData.Type {
	case types.BUFFER:
		intSlice := make([]int, len(testData.Data.([]byte)))
		for i, b := range testData.Data.([]byte) {
			intSlice[i] = int(b)
		}
		testData.Data = intSlice
	case types.OBJECT:
		obj := TestObject{}
		json.Unmarshal(testData.Data.(types.DeserializedRawObject).Data, &obj)
		testData.Data = obj
	}

	return testData
}

func streamTest(
	ctx *types.Context,
	streamId uint8,
	data []byte,
	intervalMs float64,
	async bool,
) {
	streamingFn := func() {
		for i, b := range data {
			time.Sleep(time.Millisecond * time.Duration(intervalMs))
			store.StreamChunk(ctx, streamId, []byte{b}, i == len(data)-1)
		}
	}

	if async {
		go streamingFn()
	} else {
		streamingFn()
	}
}

func benchStream(
	ctx *types.Context,
	streamId uint8,
	total int,
	chunkSize int,
	closed *atomic.Bool,
) {
	if total == 0 {
		store.StreamChunk(ctx, streamId, nil, true)
		return
	}

	chunk := make([]byte, min(chunkSize, total))
	for i := range chunk {
		chunk[i] = byte(i)
	}

	for sent := 0; sent < total; {
		if closed.Load() {
			return
		}
		size := min(chunkSize, total-sent)
		sent += size
		store.StreamChunk(ctx, streamId, chunk[:size], sent == total)
	}
}
