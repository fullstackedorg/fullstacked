package main

/*
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
	"unsafe"
)

func main() {}

//export start
func start(
	directory *C.char,
) C.uint8_t {
	id := store.NewContext(C.GoString(directory))
	return C.uint8_t(id)
}

//export stop
func stop(
	ctxId C.uint8_t,
) {
	delete(store.Contexts, uint8(ctxId))
}

var cCallback = (unsafe.Pointer)(nil)

//export callback
func callback(cb unsafe.Pointer) {
	cCallback = cb

	store.Callback = func(ctx uint8, id uint8, size int) {
		C.CallMyFunction(
			cCallback,
			C.uint8_t(ctx),
			C.uint8_t(id),
			C.int(size),
		)
	}
}

//export getResponse
func getResponse(ctx C.uint8_t, id C.uint8_t, ptr unsafe.Pointer) {
	response, err := store.GetCoreResponse(uint8(ctx), uint8(id), false)

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
