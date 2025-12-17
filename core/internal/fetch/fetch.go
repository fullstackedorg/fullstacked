package fetch

import (
	"bytes"
	"context"
	"encoding/json"
	"fullstackedorg/fullstacked/types"
	"io"
	"net/http"
	"time"
)

type FetchFn = uint8

const (
	Fetch FetchFn = 0
)

func Switch(ctx *types.CoreCallContext,
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
	}
	return nil
}

type RequestHead struct {
	Url     string
	Method  string
	Headers map[string]string
}

type ResponseHead struct {
	Status     int
	StatusText string
	Headers    map[string][]string
}

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
	client.Timeout = time.Duration(1) * time.Second

	response, err := client.Do(request)

	if err != nil {
		return ResponseHead{}, err
	}

	responseHead := ResponseHead{
		Status:     response.StatusCode,
		StatusText: response.Status,
		Headers:    response.Header,
	}

	return responseHead, nil
}
