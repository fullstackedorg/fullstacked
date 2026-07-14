package types

import "sync"

type CoreModule = uint8

const (
	Core     CoreModule = 0
	Stream   CoreModule = 1
	Test     CoreModule = 2
	Fs       CoreModule = 3
	Path     CoreModule = 4
	Os       CoreModule = 5
	Net      CoreModule = 6
	Tunnel   CoreModule = 7
	Fetch    CoreModule = 8
	Bundle   CoreModule = 9
	Dns      CoreModule = 10
	Git      CoreModule = 11
	Packages CoreModule = 12
	Dgram    CoreModule = 13
	Plugin   CoreModule = 14
)

type ModuleSwitch = func(*Context, CoreCallHeader, []DeserializedData, *CoreCallResponse) error

type CoreCallResponseType = uint8

const (
	CoreResponseError  CoreCallResponseType = 0
	CoreResponseData   CoreCallResponseType = 1
	CoreResponseStream CoreCallResponseType = 2
)

type ResponseStream struct {
	Open       func(ctx *Context, streamId uint8)
	Write      func(ctx *Context, streamId uint8, data []byte)
	WriteEvent func(ctx *Context, streamId uint8, event string, data []DeserializedData)
	Close      func(ctx *Context, streamId uint8)
}

type CoreCallResponse struct {
	Type   CoreCallResponseType
	Data   SerializableData
	Stream *ResponseStream
}

type CoreCallHeader struct {
	Sync   uint8
	Id     uint8
	Module CoreModule
	Fn     uint8
}

type StoredStream struct {
	Buffer     []byte
	Open       func(ctx *Context, streamId uint8)
	Opened     bool
	Write      func(ctx *Context, streamId uint8, data []byte)
	WriteEvent func(ctx *Context, streamId uint8, event string, data []DeserializedData)
	Close      func(ctx *Context, streamId uint8)
	Ended      bool
	Error      error
}

type StoredResponse struct {
	Type    CoreCallResponseType
	Payload []byte
}

type ContextDirectories struct {
	Root  string
	Build string
}

type PluginType = string

const (
	PluginTypeGitAuth PluginType = "git-auth"
	PluginTypeBuild   PluginType = "build"
)

type PluginRequest struct {
	Response      []DeserializedData
	ResponseError *string
	Wg            *sync.WaitGroup
}

type ContextPlugin struct {
	Id   uint8
	Name string
	Type PluginType
	Data DeserializedRawObject

	Requests      map[uint8]*PluginRequest
	RequestsMutex *sync.Mutex
}

type GitAuth struct {
	Host     string `json:"host"`
	Username string `json:"username"`
	Password string `json:"password"`
	Email    string `json:"email"`
}

type Context struct {
	Id          uint8
	Directories ContextDirectories

	Env map[string]string
	Cwd string

	Responses      map[uint8][]byte
	ResponsesMutex *sync.Mutex

	Streams      map[uint8]*StoredStream
	StreamsMutex *sync.Mutex

	NextStreamId uint8

	PluginStreamId uint8
	Plugins        map[uint8]*ContextPlugin
	PluginsMutex   *sync.Mutex

	GitAuths      map[string]*GitAuth
	GitAuthsMutex *sync.Mutex

	Exit bool
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
