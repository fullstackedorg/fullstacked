package test

import (
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"time"
)

type TestFn = uint8

const (
	Hello              TestFn = 0
	Serialization      TestFn = 1
	SerializationIndex TestFn = 2
	Stream             TestFn = 3
)

type TestObject struct {
	Foo string `json:"foo"`
}

func Switch(
	ctx *types.CoreCallContext,
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
		response.Stream = func() {
			streamTest(
				ctx,
				header,
				data[0].Data.([]byte),
				data[1].Data.(float64),
				data[2].Data.(bool),
			)
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
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []byte,
	intervalMs float64,
	async bool,
) {
	streamingFn := func() {
		for i, b := range data {
			time.Sleep(time.Millisecond * time.Duration(intervalMs))
			store.StreamChunk(ctx, header, []byte{b}, i == len(data)-1)
		}
	}

	if async {
		go streamingFn()
	} else {
		streamingFn()
	}
}
