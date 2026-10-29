package router

import (
	"encoding/json"
	"fullstackedorg/fullstacked/internal/bundle"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"strconv"
)

// Set once by the host with setPlatform: its name for GET /platform, and
// whether it reads request bodies (POST /call and /sync, GET /bridge).
var Platform = ""
var BinaryCalls = true

// HandleRequest answers a request of the page of context ctxId, so hosts
// only forward them: GET /platform, /ctx, /bridge and /version, POST /call and /sync
// (the body is the payload, the response the core response), GET
// /stream/detach and static files. GET /stream, the message channels and the
// UI endpoints of a host stay with the host.
func HandleRequest(ctxId uint8, path string, body []byte) (status int, mimeType string, data []byte) {
	switch path {
	case "/platform":
		return 200, "text/plain", []byte(Platform)
	case "/ctx":
		return 200, "text/plain", []byte(strconv.Itoa(int(ctxId)))
	case "/version":
		// the running core's version without the bridge: a page whose bundle
		// was built for another runtime (its bridge cannot talk to this core)
		// still learns which runtime it runs on, e.g. to fetch a matching build.
		// Pages built for older runtimes rely on it: keep the path and the
		// { major, minor, patch, build } shape stable.
		data, _ := json.Marshal(bundle.FullStackedVersion())
		return 200, "application/json", data
	case "/bridge":
		if BinaryCalls {
			return 200, "text/plain", []byte("binary")
		}
		return 200, "text/plain", []byte("message")
	case "/call", "/sync":
		response, err := CallWithResponse(body)
		if err != nil {
			response, _ = store.BuildResponse(nil, types.CoreCallResponse{
				Type: types.CoreResponseError,
				Data: err.Error(),
			})
		}
		return 200, "application/octet-stream", response
	}

	ctx, ok := store.GetContext(ctxId)
	if !ok {
		return 404, "text/plain", []byte("Not Found")
	}

	if path == "/stream/detach" {
		// the page did not get the hello frame, it keeps the evaluated chunks
		ctx.Frames.Detach(0)
		return 200, "text/plain", nil
	}

	mimeType, contents, found := resolveStaticFile(ctx, path)
	if !found {
		return 404, "text/plain", []byte("Not Found")
	}
	return 200, mimeType, contents
}
