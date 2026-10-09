package main

/*
// #include <android/log.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

typedef void (*Callback)(uint8_t ctx, uint8_t id, int size);
static inline void CallMyFunction(void *callback, uint8_t ctx, uint8_t id, int size) {
    ((Callback)callback)(ctx, id, size);
}

*/
import "C"

import (
	"fmt"
	"fullstackedorg/fullstacked/internal/router"
	"fullstackedorg/fullstacked/internal/store"
	"unsafe"
)

func main() {}

//export start
func start(
	root *C.char,
	build *C.char,
) C.uint8_t {
	rootStr := C.GoString(root)
	buildStr := C.GoString(build)

	id := store.NewContext(rootStr, buildStr, false)
	return C.uint8_t(id)
}

//export startWithCtx
func startWithCtx(
	root *C.char,
	build *C.char,
	ctxId C.uint8_t,
) {
	rootStr := C.GoString(root)
	buildStr := C.GoString(build)

	store.NewContextWithCtxId(uint8(ctxId), rootStr, buildStr, false)
}

//export startSafe
func startSafe(
	root *C.char,
	build *C.char,
) C.uint8_t {
	rootStr := C.GoString(root)
	buildStr := C.GoString(build)

	id := store.NewContext(rootStr, buildStr, true)
	return C.uint8_t(id)
}

//export check
func check(
	ctxId C.uint8_t,
) C.int {
	ctx, ok := store.GetContext(uint8(ctxId))
	if !ok || ctx.Exited {
		return 0
	}
	return 1
}

//export stop
func stop(
	ctxId C.uint8_t,
) {
	store.EndContext(uint8(ctxId))
}

var cCallback = (unsafe.Pointer)(nil)

//export setOnStreamData
func setOnStreamData(
	cb unsafe.Pointer,
) {
	// androidPrintToLogCat()

	cCallback = cb

	store.OnStreamData = func(ctx uint8, streamId uint8, size int) {
		C.CallMyFunction(
			cCallback,
			C.uint8_t(ctx),
			C.uint8_t(streamId),
			C.int(size),
		)
	}
}

//export getCorePayload
func getCorePayload(
	ctx C.uint8_t,
	coreType C.uint8_t,
	id C.uint8_t,
	ptr unsafe.Pointer,
	size C.int,
) {
	response, err := store.GetCorePayload(uint8(ctx), uint8(coreType), uint8(id), int(size))

	if err != nil {
		fmt.Println(err.Error())
		return
	}

	// the host allocated size bytes at ptr
	copy(unsafe.Slice((*byte)(ptr), int(size)), response)
}

//export call
func call(buffer unsafe.Pointer, length C.int) C.int {
	size, err := router.Call(C.GoBytes(buffer, length))

	if err != nil {
		fmt.Println(err.Error())
		return 0
	}

	return C.int(size)
}

// callWithResponse processes the call and returns its response in one
// transition, without storing it by request id. The host owns the returned
// buffer of *size bytes and frees it with freePtr. Returns nil and size 0
// on error.
//
//export callWithResponse
func callWithResponse(buffer unsafe.Pointer, length C.int, size *C.int) unsafe.Pointer {
	response, err := router.CallWithResponse(C.GoBytes(buffer, length))

	if err != nil || len(response) == 0 {
		if err != nil {
			fmt.Println(err.Error())
		}
		*size = 0
		return nil
	}

	*size = C.int(len(response))
	return C.CBytes(response)
}

// setPlatform tells the core the name of the host for GET /platform and
// whether it reads request bodies (POST /call and /sync), once at start.
//
//export setPlatform
func setPlatform(name *C.char, binaryCalls C.int) {
	router.Platform = C.GoString(name)
	router.BinaryCalls = binaryCalls != 0
}

// handleRequest answers a request of the page of the context (see
// router.HandleRequest): *status is the HTTP status, the returned buffer of
// *size bytes is "<mime type>\n<body>", freed with freePtr.
//
//export handleRequest
func handleRequest(ctxId C.uint8_t, path *C.char, body unsafe.Pointer, length C.int, status *C.int, size *C.int) unsafe.Pointer {
	var payload []byte
	if body != nil && length > 0 {
		payload = C.GoBytes(body, length)
	}
	code, mimeType, data := router.HandleRequest(uint8(ctxId), C.GoString(path), payload)
	// written in place, the body is copied once
	n := len(mimeType) + 1 + len(data)
	ptr := C.malloc(C.size_t(n))
	response := unsafe.Slice((*byte)(ptr), n)
	copy(response, mimeType)
	response[len(mimeType)] = '\n'
	copy(response[len(mimeType)+1:], data)
	*status = C.int(code)
	*size = C.int(n)
	return ptr
}

// callMessage processes a call received on a message channel (see
// router.CallForMessage). Returns the response in a buffer of *size bytes
// freed with freePtr, or nil with *size -1 when the response was queued on
// the frame stream: the reply carries nothing then.
//
//export callMessage
func callMessage(buffer unsafe.Pointer, length C.int, size *C.int) unsafe.Pointer {
	response, framed := router.CallForMessage(C.GoBytes(buffer, length))
	if framed {
		*size = -1
		return nil
	}
	*size = C.int(len(response))
	return C.CBytes(response)
}

// streamAttach makes the caller the reader of the stream frames of the
// context (GET /stream), see package frames. Returns the reader generation
// to pass to streamRead and streamDetach, or -1 for an unknown context.
//
//export streamAttach
func streamAttach(ctxId C.uint8_t) C.int {
	ctx, ok := store.GetContext(uint8(ctxId))
	if !ok {
		return -1
	}
	gen := ctx.Frames.Attach()
	if gen == 0 {
		return -1
	}
	return C.int(gen)
}

// streamRead blocks until frames are queued and returns them, whole frames
// only, in a buffer of *size bytes freed with freePtr. Returns nil once the
// reader is replaced, detached or the context ended: finish the response.
//
//export streamRead
func streamRead(ctxId C.uint8_t, gen C.int, size *C.int) unsafe.Pointer {
	*size = 0
	ctx, ok := store.GetContext(uint8(ctxId))
	if !ok {
		return nil
	}
	data := ctx.Frames.Read(int(gen))
	if len(data) == 0 {
		return nil
	}
	*size = C.int(len(data))
	return C.CBytes(data)
}

// streamDetach ends the reader of gen (response cancelled), or the current
// one for gen 0 (GET /stream/detach), the stream data of the context goes
// back to the setOnStreamData callback.
//
//export streamDetach
func streamDetach(ctxId C.uint8_t, gen C.int) {
	ctx, ok := store.GetContext(uint8(ctxId))
	if ok {
		ctx.Frames.Detach(int(gen))
	}
}

//export freePtr
func freePtr(ptr unsafe.Pointer) {
	C.free(ptr)
}

// func androidPrintToLogCat() {
// 	r, w, _ := os.Pipe()
// 	os.Stdout = w
// 	os.Stderr = w

// 	go func() {
// 		for {
// 			buffer := make([]byte, 2048)
// 			n, _ := r.Read(buffer)

// 			if n > 0 {
// 				ctag := C.CString("go")
// 				cstr := C.CString(string(buffer[0:n]))
// 				C.__android_log_write(C.ANDROID_LOG_INFO, ctag, cstr)
// 				C.free(unsafe.Pointer(ctag))
// 				C.free(unsafe.Pointer(cstr))
// 			}

// 		}
// 	}()
// }
