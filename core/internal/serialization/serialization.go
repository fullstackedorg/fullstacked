package serialization

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"math"
)

type DataType = uint8

const (
	UNDEFINED DataType = 0
	BOOLEAN   DataType = 1
	STRING    DataType = 2
	NUMBER    DataType = 3
	BUFFER    DataType = 4
	OBJECT    DataType = 5
)

const MAX_UINT_4_BYTES = 4294967295

func NumberToUin4Bytes(num int) ([]byte, error) {
	if num < 0 {
		return nil, errors.New("cannot convert negative number to uint 4 bytes")
	}

	if num > MAX_UINT_4_BYTES {
		return nil, errors.New("converting too high number to uint 4 bytes")
	}

	bytes := make([]byte, 4)
	bytes[0] = uint8((uint(num) & uint(0xff000000)) >> 24)
	bytes[1] = uint8((num & 0x00ff0000) >> 16)
	bytes[2] = uint8((num & 0x0000ff00) >> 8)
	bytes[3] = uint8((num & 0x000000ff) >> 0)
	return bytes, nil
}
func Uint4BytesToNumber(bytes []byte) (int, error) {
	if bytes == nil {
		return 0, errors.New("cant convert nil to int")
	}

	if len(bytes) != 4 {
		return 0, errors.New("[]byte for uint 4 bytes must be of size 4")
	}

	return int((uint(bytes[0]) << 24) |
		(uint(bytes[1]) << 16) |
		(uint(bytes[2]) << 8) |
		(uint(bytes[3]) << 0)), nil
}

func SerializeUndefined() []byte {
	return []byte{UNDEFINED}
}
func DeserializeUndefined(buffer []byte, index int) (any, int, error) {
	if index+1 < len(buffer) {
		return nil, 1, errors.New("buffer too short for undefined deserialize")
	}

	if buffer[index] != UNDEFINED {
		return nil, 1, errors.New("wrong type for undefined")
	}

	return nil, 1, nil
}

func SerializeBoolean(boolean bool) []byte {
	buffer := make([]byte, 2)
	buffer[0] = BOOLEAN
	if boolean {
		buffer[1] = 1
	} else {
		buffer[1] = 0
	}
	return buffer
}
func DeserializeBoolean(buffer []byte, index int) (bool, int, error) {
	if index+2 > len(buffer) {
		return false, 2, errors.New("buffer too short for boolean")
	}

	if buffer[index] != BOOLEAN {
		return false, 2, errors.New("wrong type for boolean")
	}

	switch buffer[index+1] {
	case 1:
		return true, 2, nil
	case 0:
		return false, 2, nil
	}

	return false, 2, errors.New("wrong value for boolean")
}

func SerializeString(str string) ([]byte, error) {
	strData := []byte(str)
	strSize := len(strData)
	size, err := NumberToUin4Bytes(strSize)

	if err != nil {
		return nil, errors.New("problem with str size serialize")
	}

	buffer := make([]byte, strSize+5)
	buffer[0] = STRING

	copy(buffer[1:5], size)
	copy(buffer[5:], strData)

	return buffer, nil
}
func DeserializeString(buffer []byte, index int) (string, int, error) {
	if buffer[index] != STRING {
		return "", 0, errors.New("wrong type for string")
	}
	index++

	size, err := Uint4BytesToNumber(buffer[index : index+4])

	if err != nil {
		return "", size + 5, errors.New("problem with str size deserialize")
	}

	if index+size > len(buffer) {
		return "", size + 5, errors.New("buffer length too short to get slice of expected size")
	}
	index += 4

	return string(buffer[index : index+size]), size + 5, nil
}

func SerializeNumber(num float64) []byte {
	buffer := make([]byte, 9)
	buffer[0] = NUMBER
	binary.BigEndian.PutUint64(buffer[1:], math.Float64bits(num))
	return buffer
}
func DeserializeNumber(buffer []byte, index int) (float64, int, error) {
	if index+9 > len(buffer) {
		return 0, 9, errors.New("buffer too short for number deserialize")
	}

	if buffer[index] != NUMBER {
		return 0, 9, errors.New("wrong type for number")
	}
	index++

	bits := binary.BigEndian.Uint64(buffer[index : index+8])
	float := math.Float64frombits(bits)
	return float, 9, nil
}

func SerializeBuffer(buffer []byte) ([]byte, error) {
	bufferSize := len(buffer)
	size, err := NumberToUin4Bytes(bufferSize)

	if err != nil {
		return nil, errors.New("problem with buffer size serialize")
	}

	buffer2 := make([]byte, bufferSize+5)
	buffer2[0] = BUFFER
	copy(buffer2[1:5], size)
	copy(buffer2[5:], buffer)
	return buffer2, nil
}
func DeserializeBuffer(buffer []byte, index int) ([]byte, int, error) {
	if buffer[index] != BUFFER {
		return nil, 0, errors.New("wrong type for buffer")
	}
	index++

	size, err := Uint4BytesToNumber(buffer[index : index+4])

	if err != nil {
		return nil, size + 5, errors.New("problem with buffer size deserialize")
	}

	if index+size > len(buffer) {
		return nil, size + 5, errors.New("buffer too short for buffer deserialize")
	}
	index += 4

	return buffer[index : index+size], size + 5, nil
}

func SerializeObject(obj any) ([]byte, error) {
	jsonBuffer, err := json.Marshal(obj)

	if err != nil {
		return nil, errors.New("failed to marshal object")
	}

	jsonBufferSize := len(jsonBuffer)
	size, err := NumberToUin4Bytes(jsonBufferSize)

	if err != nil {
		return nil, errors.New("problem with object size serialize")
	}

	buffer := make([]byte, jsonBufferSize+5)
	buffer[0] = OBJECT
	copy(buffer[1:5], size)
	copy(buffer[5:], jsonBuffer)
	return buffer, nil
}

type Object struct {
	Data []byte
}

func DeserializeObject(buffer []byte, index int) (Object, int, error) {
	obj := Object{}
	if buffer[index] != OBJECT {
		return obj, 0, errors.New("wrong type for object")
	}
	index++

	size, err := Uint4BytesToNumber(buffer[index : index+4])

	if err != nil {
		return obj, size + 5, errors.New("problem with object size deserialize")
	}

	if index+size > len(buffer) {
		return obj, size + 5, errors.New("buffer too short for object deserialize")
	}
	index += 4

	obj.Data = buffer[index : index+size]
	return obj, size + 5, nil
}

func Serialize(data interface{}) ([]byte, error) {
	serialized := ([]byte)(nil)
	err := (error)(nil)
	switch data := data.(type) {
	case nil:
		serialized = SerializeUndefined()
	case bool:
		serialized = SerializeBoolean(data)
	case float64:
		serialized = SerializeNumber(data)
	case string:
		serialized, err = SerializeString(data)
	case []byte:
		serialized, err = SerializeBuffer(data)
	default:
		serialized, err = SerializeObject(data)
	}

	return serialized, err
}

func deserializeData(buffer []byte, index int) (any, int, error) {
	dataType := buffer[0]
	switch dataType {
	case UNDEFINED:
		return DeserializeUndefined(buffer, index)
	case BUFFER:
		return DeserializeBuffer(buffer, index)
	case BOOLEAN:
		return DeserializeBoolean(buffer, index)
	case STRING:
		return DeserializeString(buffer, index)
	case NUMBER:
		return DeserializeNumber(buffer, index)
	case OBJECT:
		return DeserializeObject(buffer, index)
	}

	return nil, 0, errors.New("unknown data type for buffer")
}

func Deserialize(buffer []byte) ([]any, error) {
	data := []any{}
	index := 0
	for index < len(buffer) {
		deserialized, size, err := deserializeData(buffer, index)
		if (err) != nil {
			return data, err
		}
		index += size
		data = append(data, deserialized)
	}
	return data, nil
}

func MergeBuffers(buffers [][]byte) []byte {
	size := 0
	for _, buf := range buffers {
		size += len(buf)
	}

	buffer := make([]byte, size)
	offset := 0
	for _, buf := range buffers {
		size := len(buf)
		copy(buffer[offset:offset+size], buf)
		offset += size
	}

	return buffer
}
