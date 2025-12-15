package main

/*
#include <stdlib.h>
#include <string.h>

typedef void (*Callback)(char *projectId, char* type, void *msg, int msgLength);
static inline void CallMyFunction(void *callback, char *projectId, char * type, void *msg, int msgLength) {
    ((Callback)callback)(projectId, type, msg, msgLength);
}

static inline void write_bytes_array(void *data, int size, void *ptr) {
	memcpy(ptr, data, size);
}
*/
import "C"

import (
	"fmt"
	"fullstackedorg/fullstacked/internal/router"
	"unsafe"
)

func main() {}

//export start
func start(
	directory *C.char,
) C.uint8_t {
	id := router.NewContext(C.GoString(directory))
	return C.uint8_t(id)
}

var cCallback = (unsafe.Pointer)(nil)

//export callback
func callback(cb unsafe.Pointer) {

}

//export getResponse
func getResponse(ctx C.uint8_t, id C.uint8_t, ptr unsafe.Pointer) {
	response, err := router.GetCoreResponse(uint8(ctx), uint8(id))

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
