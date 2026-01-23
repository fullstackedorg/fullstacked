package fetch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"io"
	"net/http"
	"sync"
)

type FetchFn = uint8

const (
	Fetch        FetchFn = 0
	ResponseBody FetchFn = 1
)

func Switch(
	ctx *types.CoreCallContext,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Fetch:
		requestHead := RequestHead{}
		json.Unmarshal(data[0].Data.(types.DeserializedRawObject).Data, &requestHead)

		requestBody := ([]byte)(nil)
		if data[1].Type == types.BUFFER {
			requestBody = data[1].Data.([]byte)
		}

		res, err := FetchFnApply(requestHead, requestBody)
		if err != nil {
			return err
		}
		response.Type = types.CoreResponseData
		response.Data = res
		return nil
	case ResponseBody:
		id := int(data[0].Data.(float64))
		_, ok := fetchResponses[id]
		if !ok {
			return errors.New("cannot find response")
		}
		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.CoreCallContext, streamId uint8) {
				go StreamResponse(ctx, streamId, id)
			},
		}
		return nil
	}

	return errors.New("unknown fetch function")
}

type RequestHead struct {
	Url     string
	Method  string
	Headers map[string]string
}

type ResponseHead struct {
	Id         int
	Status     int
	StatusText string
	Headers    map[string][]string
}

var fetchResponses = map[int]*http.Response{}
var fetchResponsesMutex = sync.Mutex{}
var fetchId = 0

var client = &http.Client{}

func FetchFnApply(requestHead RequestHead, body []byte) (ResponseHead, error) {
	reqBody := (io.Reader)(http.NoBody)
	if len(body) > 0 {
		reqBody = bytes.NewReader(body)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, requestHead.Method, requestHead.Url, reqBody)

	if err != nil {
		return ResponseHead{}, err
	}

	if len(requestHead.Headers) > 0 {
		for key, value := range requestHead.Headers {
			request.Header.Set(key, value)
		}
	}

	// infinite timeout
	client.Timeout = 0

	response, err := client.Do(request)

	if err != nil {
		return ResponseHead{}, err
	}

	fetchResponsesMutex.Lock()
	id := fetchId
	fetchResponses[id] = response
	fetchId += 1
	fetchResponsesMutex.Unlock()

	responseHead := ResponseHead{
		Id:         id,
		Status:     response.StatusCode,
		StatusText: response.Status,
		Headers:    response.Header,
	}

	return responseHead, nil
}

func StreamResponse(
	ctx *types.CoreCallContext,
	streamId uint8,
	responseId int,
) {
	fetchResponsesMutex.Lock()
	response, ok := fetchResponses[responseId]
	fetchResponsesMutex.Unlock()

	if !ok {
		return
	}

	defer response.Body.Close()

	for {
		buffer := make([]byte, 2048)
		n, err := response.Body.Read(buffer)
		buffer = buffer[:n]
		end := err == io.EOF
		store.StreamChunk(ctx, streamId, buffer, end)
		if end {
			break
		}
	}

	fetchResponsesMutex.Lock()
	delete(fetchResponses, responseId)
	fetchResponsesMutex.Unlock()
}
