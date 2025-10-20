package fetch

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	serialize "fullstackedorg/fullstacked/src/serialize"
	"fullstackedorg/fullstacked/src/setup"
	"io"
	"net/http"
	"sync"
	"time"
)

type Request struct {
	Cancel func()
}

var client = &http.Client{}
var activeRequestsMutex = sync.Mutex{}
var activeRequests = map[float64]Request{}

func FetchSerialized(
	projectId string,
	id float64,
	method string,
	url string,
	headers *map[string]string,
	body []byte,
	timeout int,
	asString bool,
) {
	requestBody := (io.Reader)(http.NoBody)
	if len(body) > 0 {
		requestBody = bytes.NewReader(body)
	}

	request, _ := http.NewRequest(method, url, requestBody)

	if headers != nil {
		for key, value := range *headers {
			request.Header.Set(key, value)
		}
	}

	client.Timeout = time.Duration(timeout) * time.Second

	response, err := client.Do(request)
	bytes := []byte{}
	if err != nil {
		bytes = append(bytes, serialize.SerializeNumber(id)...)
		bytes = append(bytes, serialize.SerializeNumber(float64(500))...)
		bytes = append(bytes, serialize.SerializeString("Failed fecth")...)
		bytes = append(bytes, serialize.SerializeString("{}")...)
		bytes = append(bytes, serialize.SerializeString(err.Error())...)

		setup.Callback(projectId, "fetch-response", base64.StdEncoding.EncodeToString(bytes))
		return
	}

	headersJSON, _ := json.Marshal(response.Header)

	bytes = append(bytes, serialize.SerializeNumber(id)...)
	bytes = append(bytes, serialize.SerializeNumber(float64(response.StatusCode))...)
	bytes = append(bytes, serialize.SerializeString(response.Status)...)
	bytes = append(bytes, serialize.SerializeString(string(headersJSON))...)

	responseBody, _ := io.ReadAll(response.Body)
	if asString {
		bytes = append(bytes, serialize.SerializeString(string(responseBody))...)
	} else {
		bytes = append(bytes, serialize.SerializeBuffer(responseBody)...)
	}

	setup.Callback(projectId, "fetch-response", base64.StdEncoding.EncodeToString(bytes))

	response.Body.Close()
	bytes = nil
}

var chunkSize = 2048

func CancelRequest(id float64) {
	activeRequestsMutex.Lock()
	req, ok := activeRequests[id]
	if ok {
		req.Cancel()
	}
	delete(activeRequests, id)
	activeRequestsMutex.Unlock()
}

func Fetch2(
	projectId string,
	id float64,
	method string,
	url string,
	headers *map[string]string,
	body []byte,
) {
	// body
	requestBody := (io.Reader)(http.NoBody)
	if len(body) > 0 {
		requestBody = bytes.NewReader(body)
	}

	ctx, cancel := context.WithCancel(context.Background())
	request, _ := http.NewRequestWithContext(ctx, method, url, requestBody)

	// stash cancel
	activeRequestsMutex.Lock()
	activeRequests[id] = Request{
		Cancel: cancel,
	}
	activeRequestsMutex.Unlock()

	// headers
	if headers != nil {
		for key, value := range *headers {
			request.Header.Set(key, value)
		}
	}

	// infinite timeout
	client.Timeout = time.Duration(0)

	res, err := client.Do(request)

	// req id
	response := serialize.SerializeNumber(id)
	if err != nil {
		// status code
		response = append(response, serialize.SerializeNumber(float64(500))...)
		// status message
		response = append(response, serialize.SerializeString("Failed fetch")...)
		// headers
		response = append(response, serialize.SerializeString("{}")...)
		setup.Callback(projectId, "fetch2-response", base64.StdEncoding.EncodeToString(response))
		CancelRequest(id)
		return
	}

	// status code
	response = append(response, serialize.SerializeNumber(float64(res.StatusCode))...)
	// status message
	response = append(response, serialize.SerializeString(res.Status)...)

	// status headers
	headersJSON, _ := json.Marshal(res.Header)
	response = append(response, serialize.SerializeString(string(headersJSON))...)

	setup.Callback(projectId, "fetch2-response", base64.StdEncoding.EncodeToString(response))

	go func() {
		defer res.Body.Close()

		for {
			activeRequestsMutex.Lock()
			_, ok := activeRequests[id]
			activeRequestsMutex.Unlock()
			if !ok {
				break
			}

			buffer := make([]byte, chunkSize)
			n, err := res.Body.Read(buffer)

			buffer = buffer[:n]

			done := err == io.EOF
			// req id
			chunk := serialize.SerializeNumber(id)
			// done
			chunk = append(chunk, serialize.SerializeBoolean(done)...)
			// body
			chunk = append(chunk, serialize.SerializeBuffer(buffer)...)
			setup.Callback(projectId, "fetch2-response", base64.StdEncoding.EncodeToString(chunk))

			if done {
				break
			}

			if err != nil {
				fmt.Println(err)
				break
			}
		}

		activeRequestsMutex.Lock()
		delete(activeRequests, id)
		activeRequestsMutex.Unlock()
	}()
}
