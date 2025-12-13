package router

import (
	"errors"
	"fullstackedorg/fullstacked/internal/serialization"
	"fullstackedorg/fullstacked/internal/test"
	"fullstackedorg/fullstacked/types"
	"sync"
)

var responses = map[uint8][]byte{}
var responsesMutex = sync.Mutex{}

var noResponsePayload, _ = serialization.Serialize("no response")

/*
1 byte id
1 byte module
1 byte fn
n bytes data
*/

func Call(payload []byte) (int, error) {

	if len(payload) < 3 {
		return 0, errors.New("payload needs at least id, module, function")
	}

	header := types.CoreCallHeader{
		Id:     payload[0],
		Module: payload[1],
		Fn:     payload[2],
	}

	data, err := serialization.DeserializeAll(payload[3:])

	if err != nil {
		return 0, errors.New("failed to deserialize payload data")
	}

	response := types.CoreCallResponse{}

	coreError := callProcess(header, data, &response)

	size := 0
	if coreError != nil {
		size, err = stashResponse(header, types.CoreCallResponse{
			Type: types.CoreResponseError,
			Data: coreError.Error(),
		})
	} else {
		size, err = stashResponse(header, response)
	}

	if err != nil {
		return 0, err
	}

	return size, nil
}

func GetCoreResponse(id uint8) ([]byte, error) {
	responsesMutex.Lock()
	response, ok := responses[id]
	responsesMutex.Unlock()

	if !ok {
		return nil, errors.New("cannot find response for id")
	}

	defer delete(responses, id)

	return response, nil
}

func callProcess(header types.CoreCallHeader, data []types.DeserializedData, response *types.CoreCallResponse) error {
	switch header.Module {
	case types.Test:
		return test.Switch(header.Fn, data, response)
	}

	return errors.New("unknown module")
}

func stashResponse(header types.CoreCallHeader, response types.CoreCallResponse) (int, error) {
	buffer := []byte{response.Type}

	if response.Data != nil {
		data, err := serialization.Serialize(response.Data)
		if err != nil {
			return 0, err
		}
		buffer, err = serialization.MergeBuffers([][]byte{buffer, data})
		if err != nil {
			return 0, err
		}
	}

	responsesMutex.Lock()
	responses[header.Id] = buffer
	responsesMutex.Unlock()

	return len(buffer), nil
}
