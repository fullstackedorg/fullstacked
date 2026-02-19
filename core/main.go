package main

/*
// #include <android/log.h>
#include <stdlib.h>
#include <string.h>

typedef void (*Callback)(uint8_t ctx, uint8_t id, int size);
static inline void CallMyFunction(void *callback, uint8_t ctx, uint8_t id, int size) {
    ((Callback)callback)(ctx, id, size);
}

static inline void write_bytes_array(void *data, int size, void *ptr) {
	memcpy(ptr, data, size);
}
*/
import "C"

import (
	"fmt"
	"fullstackedorg/fullstacked/internal/router"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"
	"unsafe"
)

func main() {}

//export start
func start(
	root *C.char,
	build *C.char,
) C.uint8_t {
	directories := types.ContextDirectories{
		Root:  C.GoString(root),
		Build: C.GoString(build),
	}

	id := store.NewContext(directories)
	return C.uint8_t(id)
}

//export startWithCtx
func startWithCtx(
	root *C.char,
	build *C.char,
	ctxId C.uint8_t,
) {
	store.NewContextWithCtxId(uint8(ctxId), types.ContextDirectories{
		Root:  C.GoString(root),
		Build: C.GoString(build),
	})
}

//export check
func check(
	ctxId C.uint8_t,
) C.int {
	_, ok := store.Contexts[uint8(ctxId)]
	if !ok {
		return 0
	}
	return 1
}

//export stop
func stop(
	ctxId C.uint8_t,
) {
	delete(store.Contexts, uint8(ctxId))
}

var cCallback = (unsafe.Pointer)(nil)

//export setOnStreamData
func setOnStreamData(cb unsafe.Pointer) {
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

	bytes := C.CBytes(response)
	C.write_bytes_array(bytes, C.int(len(response)), ptr)
	C.free(bytes)
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
