package types

import "sync"

type CoreModule = uint8

const (
	Core   CoreModule = 0
	Stream CoreModule = 1
	Test   CoreModule = 2
	Fs     CoreModule = 3
	Path   CoreModule = 4
	Os     CoreModule = 5
	Net    CoreModule = 6
	Fetch  CoreModule = 7
	Bundle CoreModule = 8
	Dns    CoreModule = 9
)

type ModuleSwitch = func(*CoreCallContext, CoreCallHeader, []DeserializedData, *CoreCallResponse) error

type CoreCallResponseType = uint8

const (
	CoreResponseError        CoreCallResponseType = 0
	CoreResponseData         CoreCallResponseType = 1
	CoreResponseStream       CoreCallResponseType = 2
	CoreResponseEventEmitter CoreCallResponseType = 3
)

type ResponseStream struct {
	Open  func(ctx *CoreCallContext, streamId uint8)
	Write func(ctx *CoreCallContext, streamId uint8, data []byte)
	Close func(ctx *CoreCallContext, streamId uint8)
}

type CoreCallResponse struct {
	Type   CoreCallResponseType
	Data   SerializableData
	Stream *ResponseStream
}

type CoreCallHeader struct {
	Id     uint8
	Module CoreModule
	Fn     uint8
}

type StoredStream struct {
	Buffer []byte
	Open   func(ctx *CoreCallContext, streamId uint8)
	Opened bool
	Write  func(ctx *CoreCallContext, streamId uint8, data []byte)
	Close  func(ctx *CoreCallContext, streamId uint8)
	Ended  bool
}

type StoredResponse struct {
	Type    CoreCallResponseType
	Payload []byte
}

type CoreCallContext struct {
	Id            uint8
	BaseDirectory string

	Responses      map[uint8][]byte
	ResponsesMutex *sync.Mutex

	Streams      map[uint8]*StoredStream
	StreamsMutex *sync.Mutex
}

type SerializableData = any

type SerializableDataType = uint8

const (
	UNDEFINED SerializableDataType = 0
	BOOLEAN   SerializableDataType = 1
	STRING    SerializableDataType = 2
	NUMBER    SerializableDataType = 3
	BUFFER    SerializableDataType = 4
	OBJECT    SerializableDataType = 5
)

const MAX_UINT_4_BYTES = 4294967295

type DeserializedData struct {
	Data           SerializableData
	Type           SerializableDataType
	SizeSerialized int
}

type DeserializedRawObject struct {
	Data []byte
}
