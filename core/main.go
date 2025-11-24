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
	fs "fullstackedorg/fullstacked/src/fs"
	methods "fullstackedorg/fullstacked/src/methods"
	setup "fullstackedorg/fullstacked/src/setup"
	"path"
	"sync"
	"unsafe"
)

func main() {}

//export directories
func directories(
	root *C.char,
	config *C.char,
	editor *C.char,
	tmp *C.char,
) {

	setup.SetupDirectories(
		C.GoString(root),
		C.GoString(config),
		C.GoString(editor),
		C.GoString(tmp),
	)

	fileEventOrigin := "setup"
	fs.Mkdir(setup.Directories.Root, fileEventOrigin)
	fs.Mkdir(setup.Directories.Config, fileEventOrigin)

	// clean tmp
	fs.Rmdir(setup.Directories.Tmp, fileEventOrigin)
	fs.Mkdir(setup.Directories.Tmp, fileEventOrigin)

	if methods.TSGOptr != nil {
		// if repo build, fullstacked_modules already exists
		exists, _ := fs.Exists(path.Join(setup.Directories.Root, "fullstacked_modules"))
		if !exists {
			// place fullstacked_modules for internal lsp
			fs.Copy(
				path.Join(setup.Directories.Editor, "fullstacked_modules"),
				path.Join(setup.Directories.Root, ".fullstacked_modules"),
				fileEventOrigin,
			)
		}
	}
}

var cCallback = (unsafe.Pointer)(nil)

//export callback
func callback(cb unsafe.Pointer) {
	cCallback = cb

	setup.Callback = func(projectId string, messageType string, message string) {
		projectIdPtr := C.CString(projectId)
		messageTypePtr := C.CString(messageType)

		messageData := []byte(message)
		messagePtr := C.CBytes(messageData)
		messageLength := (C.int)(len(messageData))

		C.CallMyFunction(
			cCallback,
			projectIdPtr,
			messageTypePtr,
			messagePtr,
			messageLength,
		)

		C.free(unsafe.Pointer(projectIdPtr))
		C.free(unsafe.Pointer(messageTypePtr))
		C.free(unsafe.Pointer(messagePtr))
	}
}

var responses = map[C.int][]byte{}
var responsesMutex = sync.Mutex{}

//export getResponse
func getResponse(id C.int, ptr unsafe.Pointer) {
	responsesMutex.Lock()
	response, ok := responses[id]
	responsesMutex.Unlock()

	if !ok {
		return
	}

	bytes := C.CBytes(response)
	C.write_bytes_array(bytes, C.int(len(response)), ptr)
	C.free(bytes)

	responsesMutex.Lock()
	delete(responses, id)
	responsesMutex.Unlock()
}

//export call
func call(id C.int, buffer unsafe.Pointer, length C.int) C.int {
	response := methods.Call(C.GoBytes(buffer, length))

	responsesMutex.Lock()
	responses[id] = response
	responsesMutex.Unlock()

	return C.int(len(response))
}

//export freePtr
func freePtr(ptr unsafe.Pointer) {
	C.free(ptr)
}
