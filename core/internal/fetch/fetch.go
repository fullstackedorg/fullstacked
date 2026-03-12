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
	Cancel       FetchFn = 2
)

func Switch(
	ctx *types.Context,
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

		fetchRequestsMutex.Lock()
		id := fetchId
		fetchId += 1
		fetchRequestsMutex.Unlock()

		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				res, err := FetchFnApply(id, requestHead, requestBody)

				fetchRequestsMutex.Lock()
				_, ok := fetchRequests[id]
				fetchRequestsMutex.Unlock()

				if ok {
					if err != nil {
						store.StreamEvent(ctx, streamId, "error", []types.SerializableData{err.Error()}, true)
					} else {
						store.StreamEvent(ctx, streamId, "response", []types.SerializableData{res}, true)
					}
				}
			},
			Close: func(ctx *types.Context, streamId uint8) {
				closeFetchRequest(id)
				closeFetchResponse(id)
			},
		}
		return nil
	case ResponseBody:
		id := int(data[0].Data.(float64))
		_, ok := fetchResponses[id]
		if !ok {
			return errors.New("cannot find response")
		}
		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
				fetchResponsesMutex.Lock()
				_, ok := fetchResponses[id]
				fetchResponsesMutex.Unlock()

				if !ok {
					return
				}

				StreamResponse(ctx, streamId, id)
			},
			Close: func(ctx *types.Context, streamId uint8) {
				closeFetchRequest(id)
				closeFetchResponse(id)
			},
		}
		return nil
	case Cancel:
		id := int(data[0].Data.(float64))
		closeFetchRequest(id)
		closeFetchResponse(id)
		response.Type = types.CoreResponseData
		return nil
	}

	return errors.New("unknown fetch function")
}

type RequestHead struct {
	Url     string
	Method  string
	Headers map[string]string
}

type Request struct {
	Cancel context.CancelFunc
}

var fetchId = 0

var fetchRequests = map[int]*Request{}
var fetchRequestsMutex = sync.Mutex{}

type ResponseHead struct {
	Id         int
	Status     int
	StatusText string
	Headers    map[string][]string
}

var fetchResponses = map[int]*http.Response{}
var fetchResponsesMutex = sync.Mutex{}

var client = &http.Client{}

func FetchFnApply(id int, requestHead RequestHead, body []byte) (ResponseHead, error) {
	reqBody := (io.Reader)(http.NoBody)
	if len(body) > 0 {
		reqBody = bytes.NewReader(body)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	fetchRequestsMutex.Lock()
	fetchRequests[id] = &Request{
		Cancel: cancel,
	}
	fetchRequestsMutex.Unlock()

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
	fetchResponses[id] = response
	fetchResponsesMutex.Unlock()

	responseHead := ResponseHead{
		Id:         id,
		Status:     response.StatusCode,
		StatusText: response.Status,
		Headers:    response.Header,
	}

	return responseHead, nil
}

func safelyGetResponse(responseId int) *http.Response {
	fetchResponsesMutex.Lock()
	response := fetchResponses[responseId]
	fetchResponsesMutex.Unlock()

	return response
}

func StreamResponse(
	ctx *types.Context,
	streamId uint8,
	responseId int,
) {
	response := safelyGetResponse(responseId)
	if response == nil {
		return
	}

	defer closeFetchResponse(responseId)

	for {
		response := safelyGetResponse(responseId)
		if response == nil {
			break
		}

		buffer := make([]byte, 2048)
		n, err := response.Body.Read(buffer)
		buffer = buffer[:n]
		end := err != nil

		store.StreamChunk(ctx, streamId, buffer, end)

		if end {
			break
		}
	}
}

func closeFetchRequest(id int) {
	fetchRequestsMutex.Lock()
	request, ok := fetchRequests[id]
	if ok {
		request.Cancel()
	}
	delete(fetchRequests, id)
	fetchRequestsMutex.Unlock()
}

func closeFetchResponse(id int) {
	fetchResponsesMutex.Lock()
	response, ok := fetchResponses[id]
	if ok {
		response.Body.Close()
	}
	delete(fetchResponses, id)
	fetchResponsesMutex.Unlock()
}
