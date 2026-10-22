package fetch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/internal/tunnel"
	"fullstackedorg/fullstacked/types"
	"io"
	"net"
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

				// a request the page closed (abort) ended its stream already
				fetchRequestsMutex.Lock()
				_, ok := fetchRequests[id]
				fetchRequestsMutex.Unlock()

				if !ok {
					return
				}

				// every other outcome ends the stream, or the page's fetch
				// waits forever (a dropped connection, a refused dial)
				if err != nil {
					closeFetchRequest(id)
					store.StreamEvent(ctx, streamId, "error", []types.SerializableData{err.Error()}, true)
				} else {
					store.StreamEvent(ctx, streamId, "response", []types.SerializableData{res}, true)
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
		fetchResponsesMutex.Lock()
		_, ok := fetchResponses[id]
		fetchResponsesMutex.Unlock()
		if !ok {
			return errors.New("cannot find response")
		}
		response.Type = types.CoreResponseStream
		response.Stream = &types.ResponseStream{
			Open: func(ctx *types.Context, streamId uint8) {
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
	Url      string
	Method   string
	Headers  map[string]string
	Redirect *bool
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
	Url        string
}

var fetchResponses = map[int]*http.Response{}
var fetchResponsesMutex = sync.Mutex{}

var client = &http.Client{
	Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, _, err := net.SplitHostPort(addr)
			if err != nil {
				host = addr
			}

			t := tunnel.FindTunnel(host)
			if t != nil {
				return t.Dial(ctx)
			}

			var dialer net.Dialer
			return dialer.DialContext(ctx, network, addr)
		},
		// a custom DialContext disables HTTP/2 unless forced,
		// and Cloudflare blocks Go's TLS client over HTTP/1.1
		ForceAttemptHTTP2: true,
	},
}

func FetchFnApply(id int, requestHead RequestHead, body []byte) (ResponseHead, error) {
	reqBody := (io.Reader)(http.NoBody)
	if len(body) > 0 {
		reqBody = bytes.NewReader(body)
	}

	ctx, cancel := context.WithCancel(context.Background())

	fetchRequestsMutex.Lock()
	fetchRequests[id] = &Request{
		Cancel: cancel,
	}
	fetchRequestsMutex.Unlock()

	// on error, the caller closes the request once it checked whether the
	// page closed it first
	request, err := http.NewRequestWithContext(ctx, requestHead.Method, requestHead.Url, reqBody)

	if err != nil {
		return ResponseHead{}, err
	}

	if len(requestHead.Headers) > 0 {
		for key, value := range requestHead.Headers {
			request.Header.Set(key, value)
		}
	}

	followRedirect := true
	if requestHead.Redirect != nil {
		followRedirect = *requestHead.Redirect
	}

	reqClient := &http.Client{
		Transport: client.Transport,
		Timeout:   0,
	}
	if !followRedirect {
		reqClient.CheckRedirect = func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}

	response, err := reqClient.Do(request)

	if err != nil {
		return ResponseHead{}, err
	}

	fetchResponsesMutex.Lock()
	fetchResponses[id] = response
	fetchResponsesMutex.Unlock()

	finalUrl := requestHead.Url
	if response.Request != nil && response.Request.URL != nil {
		finalUrl = response.Request.URL.String()
	}

	responseHead := ResponseHead{
		Id:         id,
		Status:     response.StatusCode,
		StatusText: response.Status,
		Headers:    response.Header,
		Url:        finalUrl,
	}

	return responseHead, nil
}

func safelyGetResponse(responseId int) *http.Response {
	fetchResponsesMutex.Lock()
	response := fetchResponses[responseId]
	fetchResponsesMutex.Unlock()

	return response
}

// StreamResponse streams the body until it ends, always ending the stream:
// with an error when the body is cut short (connection dropped), so the page
// does not take a truncated body for a whole one
func StreamResponse(
	ctx *types.Context,
	streamId uint8,
	responseId int,
) {
	defer closeFetchRequest(responseId)
	defer closeFetchResponse(responseId)

	for {
		response := safelyGetResponse(responseId)
		if response == nil {
			// closed by the page (or never there), the store drops the end
			// of a stream the page already closed
			store.StreamChunk(ctx, streamId, nil, true)
			return
		}

		buffer := make([]byte, 2048)
		n, err := response.Body.Read(buffer)

		if err == nil || err == io.EOF {
			store.StreamChunk(ctx, streamId, buffer[:n], err != nil)
			if err != nil {
				return
			}
			continue
		}

		if n > 0 {
			store.StreamChunk(ctx, streamId, buffer[:n], false)
		}
		store.StreamError(ctx, streamId, err)
		return
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
