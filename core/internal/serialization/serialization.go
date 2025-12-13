package serialization

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/types"
	"math"
	"strconv"
)

func NumberToUin4Bytes(num int) ([]byte, error) {
	if num < 0 {
		return nil, errors.New("cannot convert negative number to uint 4 bytes")
	}

	if num > types.MAX_UINT_4_BYTES {
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

func serializeUndefined() []byte {
	return []byte{types.UNDEFINED}
}
func deserializeUndefined(buffer []byte, index int) (types.SerializableData, int, error) {
	if index+1 > len(buffer) {
		return nil, 1, errors.New("buffer too short for undefined deserialize")
	}

	if buffer[index] != types.UNDEFINED {
		return nil, 1, errors.New("wrong type for undefined")
	}

	return nil, 1, nil
}

func serializeBoolean(boolean bool) []byte {
	buffer := make([]byte, 2)
	buffer[0] = types.BOOLEAN
	if boolean {
		buffer[1] = 1
	} else {
		buffer[1] = 0
	}
	return buffer
}
func deserializeBoolean(buffer []byte, index int) (bool, int, error) {
	if index+2 > len(buffer) {
		return false, 2, errors.New("buffer too short for boolean")
	}

	if buffer[index] != types.BOOLEAN {
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

func serializeString(str string) ([]byte, error) {
	strData := []byte(str)
	strSize := len(strData)
	size, err := NumberToUin4Bytes(strSize)

	if err != nil {
		return nil, errors.New("problem with str size serialize")
	}

	buffer := make([]byte, strSize+5)
	buffer[0] = types.STRING

	copy(buffer[1:5], size)
	copy(buffer[5:], strData)

	return buffer, nil
}
func deserializeString(buffer []byte, index int) (string, int, error) {
	if index+5 > len(buffer) {
		return "", 0, errors.New("buffer too short for string deserialize")
	}

	if buffer[index] != types.STRING {
		return "", 0, errors.New("wrong type for string")
	}
	index++

	size, _ := Uint4BytesToNumber(buffer[index : index+4])
	index += 4

	if index+size > len(buffer) {
		return "", size + 5, errors.New("buffer length too short to get slice of expected size")
	}

	return string(buffer[index : index+size]), size + 5, nil
}

func serializeNumber(num float64) []byte {
	buffer := make([]byte, 9)
	buffer[0] = types.NUMBER
	binary.BigEndian.PutUint64(buffer[1:], math.Float64bits(num))
	return buffer
}
func deserializeNumber(buffer []byte, index int) (float64, int, error) {
	if index+9 > len(buffer) {
		return 0, 9, errors.New("buffer too short for number deserialize")
	}

	if buffer[index] != types.NUMBER {
		return 0, 9, errors.New("wrong type for number")
	}
	index++

	bits := binary.BigEndian.Uint64(buffer[index : index+8])
	float := math.Float64frombits(bits)
	return float, 9, nil
}

func serializeBuffer(buffer []byte) ([]byte, error) {
	bufferSize := len(buffer)
	size, err := NumberToUin4Bytes(bufferSize)

	if err != nil {
		return nil, errors.New("problem with buffer size serialize")
	}

	buffer2 := make([]byte, bufferSize+5)
	buffer2[0] = types.BUFFER
	copy(buffer2[1:5], size)
	copy(buffer2[5:], buffer)
	return buffer2, nil
}
func deserializeBuffer(buffer []byte, index int) ([]byte, int, error) {
	if index+5 > len(buffer) {
		return nil, 0, errors.New("buffer too short for buffer deserialize")
	}

	if buffer[index] != types.BUFFER {
		return nil, 0, errors.New("wrong type for buffer")
	}
	index++

	size, _ := Uint4BytesToNumber(buffer[index : index+4])
	index += 4

	if index+size > len(buffer) {
		return nil, size + 5, errors.New("buffer too short for buffer deserialize")
	}

	return buffer[index : index+size], size + 5, nil
}

func serializeObject(obj any) ([]byte, error) {
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
	buffer[0] = types.OBJECT
	copy(buffer[1:5], size)
	copy(buffer[5:], jsonBuffer)
	return buffer, nil
}

func deserializeObject(buffer []byte, index int) (types.DeserializedRawObject, int, error) {
	obj := types.DeserializedRawObject{}

	if index+5 > len(buffer) {
		return obj, 0, errors.New("buffer too short for object deserialize")
	}

	if buffer[index] != types.OBJECT {
		return obj, 0, errors.New("wrong type for object")
	}
	index++

	size, _ := Uint4BytesToNumber(buffer[index : index+4])
	index += 4

	if index+size > len(buffer) {
		return obj, size + 5, errors.New("buffer too short for object deserialize")
	}

	obj.Data = buffer[index : index+size]
	return obj, size + 5, nil
}

func Serialize(data types.SerializableData) ([]byte, error) {
	serialized := ([]byte)(nil)
	err := (error)(nil)
	switch data := data.(type) {
	case nil:
		serialized = serializeUndefined()
	case bool:
		serialized = serializeBoolean(data)
	case float64:
		serialized = serializeNumber(data)
	case string:
		serialized, err = serializeString(data)
	case []byte:
		serialized, err = serializeBuffer(data)
	default:
		serialized, err = serializeObject(data)
	}

	return serialized, err
}

func MergeBuffers(buffers [][]byte) ([]byte, error) {
	if buffers == nil {
		return nil, errors.New("cannot merge nil buffers")
	}

	size := 0
	for _, buf := range buffers {
		if buf == nil {
			return nil, errors.New("received nil buffer to merge")
		}
		size += len(buf)
	}

	buffer := make([]byte, size)
	offset := 0
	for _, buf := range buffers {
		size := len(buf)
		copy(buffer[offset:offset+size], buf)
		offset += size
	}

	return buffer, nil
}

func Deserialize(buffer []byte, index int) (types.DeserializedData, error) {
	if len(buffer) == 0 || buffer == nil {
		return types.DeserializedData{}, errors.New("buffer is nil or size 0")
	}

	dataType := buffer[index]
	data := (types.SerializableData)(nil)
	size := 0
	err := (error)(nil)
	switch dataType {
	case types.UNDEFINED:
		data, size, err = deserializeUndefined(buffer, index)
	case types.BOOLEAN:
		data, size, err = deserializeBoolean(buffer, index)
	case types.STRING:
		data, size, err = deserializeString(buffer, index)
	case types.NUMBER:
		data, size, err = deserializeNumber(buffer, index)
	case types.BUFFER:
		data, size, err = deserializeBuffer(buffer, index)
	case types.OBJECT:
		data, size, err = deserializeObject(buffer, index)
	default:
		return types.DeserializedData{}, errors.New("unknown data type for buffer")
	}

	if err != nil {
		return types.DeserializedData{}, errors.New("failed to deserialize data of type: " + strconv.Itoa(int(dataType)))
	}
	return types.DeserializedData{
		Data:           data,
		Type:           dataType,
		SizeSerialized: size,
	}, nil
}

func DeserializeAll(buffer []byte) ([]types.DeserializedData, error) {
	if buffer == nil {
		return nil, errors.New("cannot deserialize all buffer nil or size 0")
	}

	data := []types.DeserializedData{}
	index := 0
	for index < len(buffer) {
		deserialized, err := Deserialize(buffer, index)
		if (err) != nil {
			return data, err
		}
		index += deserialized.SizeSerialized
		data = append(data, deserialized)
	}
	return data, nil
}
