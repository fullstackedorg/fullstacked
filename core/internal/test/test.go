package test

import (
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/types"
)

type TestFn = uint8

const (
	Hello              TestFn = 0
	Serialization      TestFn = 1
	SerializationIndex TestFn = 2
)

type TestObject struct {
	Foo string `json:"foo"`
}

func Switch(
	ctx *types.CoreCallContext,
	fn TestFn,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch fn {
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
