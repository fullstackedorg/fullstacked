package serialization

import "errors"

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
func DeserializeUndefined(buffer []byte) (any, error) {
	if len(buffer) != 1 {
		return nil, errors.New("buffer length for undefined is not of size 1")
	}

	if buffer[0] != UNDEFINED {
		return nil, errors.New("wrong type for undefined")
	}

	return nil, nil
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
func DeserializeBoolean(buffer []byte) (bool, error) {
	if len(buffer) != 2 {
		return false, errors.New("buffer length for boolean is not of size 2")
	}

	if buffer[0] != BOOLEAN {
		return false, errors.New("wrong type for boolean")
	}

	if buffer[1] == 1 {
		return true, nil
	}

	return false, nil
}

func SerializeString() {
}
func DeserializeString() {

}

func SerializeNumber()   {}
func DeserializeNumber() {}

func SerializeBuffer()   {}
func DeserializeBuffer() {}

func SerializeObject()   {}
func DeserializeObject() {}
