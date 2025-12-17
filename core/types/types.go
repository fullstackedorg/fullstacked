package types

import "sync"

type CoreModule = uint8

const (
	Core  CoreModule = 0
	Test  CoreModule = 1
	Fs    CoreModule = 2
	Path  CoreModule = 3
	Os    CoreModule = 4
	Net   CoreModule = 5
	Fetch CoreModule = 6
)

type CoreCallResponseType = uint8

const (
	CoreResponseError        CoreCallResponseType = 0
	CoreResponseData         CoreCallResponseType = 1
	CoreResponseStream       CoreCallResponseType = 2
	CoreResponseEventEmitter CoreCallResponseType = 3
)

type CoreCallResponse struct {
	Type   CoreCallResponseType
	Data   SerializableData
	Stream func()
}

type CoreCallHeader struct {
	Id     uint8
	Module uint8
	Fn     uint8
}

type StoredResponse struct {
	Type   CoreCallResponseType
	Buffer []byte
	Stream func()
	Opened bool
	Ended  bool
}

type CoreCallContext struct {
	Id             uint8
	BaseDirectory  string
	Responses      map[uint8]*StoredResponse
	ResponsesMutex *sync.Mutex
}

type SerializableData = any

type SerializableDataType = uint8

const (
	UNDEFINED SerializableDataType = 0
	BOOLEAN   SerializableDataType = 1
	STRING    SerializableDataType = 2
	NUMBER    SerializableDataType = 4
	BUFFER    SerializableDataType = 5
	OBJECT    SerializableDataType = 6
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
