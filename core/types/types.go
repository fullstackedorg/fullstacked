package types

type CoreModule = uint8

const (
	Test CoreModule = 0
	Fs   CoreModule = 1
	Path CoreModule = 2
	Os   CoreModule = 3
	Net  CoreModule = 4
)

type CoreCallResponseType = uint8

const (
	CoreResponseError        CoreCallResponseType = 0
	CoreResponseData         CoreCallResponseType = 1
	CoreResponseStream       CoreCallResponseType = 2
	CoreResponseEventEmitter CoreCallResponseType = 3
)

type CoreCallResponse struct {
	Type CoreCallResponseType
	Data SerializableData
}

type CoreCallHeader struct {
	Id     uint8
	Module uint8
	Fn     uint8
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
