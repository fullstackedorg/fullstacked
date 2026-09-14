import SwiftUI

//const (
//    UNDEFINED SerializableDataType = 0
//    BOOLEAN   SerializableDataType = 1
//    STRING    SerializableDataType = 2
//    NUMBER    SerializableDataType = 3
//    BUFFER    SerializableDataType = 4
//    OBJECT    SerializableDataType = 5
//)

enum SerializableDataType: UInt8 {
    case UNDEFINED = 0
    case BOOLEAN = 1
    case STRING = 2
    case NUMBER = 3
    case BUFFER = 4
    case OBJECT = 5
}

func NumberToUint4Bytes(num: Int) -> Data {
    var bytes = Data(count: 4)
    bytes[0] = UInt8((num & 0xff000000) >> 24);
    bytes[1] = UInt8((num & 0x00ff0000) >> 16)
    bytes[2] = UInt8((num & 0x0000ff00) >> 8)
    bytes[3] = UInt8((num & 0x000000ff) >> 0)
    return bytes
}
func Uint4BytesToNumber(bytes: Data) -> Int {
    let bytes = [UInt8](bytes)
    var value : UInt = 0
    for byte in bytes {
        value = value << 8
        value = value | UInt(byte)
    }
    return Int(value)
}

func deserializeString(buffer: Data, index: Int) -> (String, Int) {
    let start = buffer.startIndex + index + 1
    guard start + 3 < buffer.endIndex else { return ("", 0) }
    let size = Uint4BytesToNumber(bytes: buffer[start...start + 3])
    guard start + 4 + size <= buffer.endIndex else { return ("", 0) }
    return (String(data: buffer[start + 4..<start + 4 + size], encoding: .utf8) ?? "", size + 5)
}

func deserializeBuffer(buffer: Data, index: Int) -> (Any, Int) {
    let start = buffer.startIndex + index + 1
    guard start + 3 < buffer.endIndex else { return (Data(), 0) }
    let size = Uint4BytesToNumber(bytes: buffer[start...start + 3])
    guard start + 4 + size <= buffer.endIndex else { return (Data(), 0) }
    return (buffer[start + 4..<start + 4 + size], size + 5)
}

func Deserialize(buffer: Data, index: Int) -> (Any?, Int) {
    guard index < buffer.count,
          let dataType = SerializableDataType(rawValue: buffer[buffer.startIndex + index]) else {
        return (nil, 0)
    }
    var data: Any? = nil
    var size = 0
    switch dataType {
    case .UNDEFINED:
        size = 1
    case .BOOLEAN:
        guard index + 1 < buffer.count else { return (nil, 0) }
        data = buffer[buffer.startIndex + index + 1] != 0
        size = 2
    case .NUMBER:
        guard index + 4 < buffer.count else { return (nil, 0) }
        data = Uint4BytesToNumber(bytes: buffer[(buffer.startIndex + index + 1)...(buffer.startIndex + index + 4)])
        size = 5
    case .STRING:
        (data, size) = deserializeString(buffer: buffer, index: index)
    case .BUFFER:
        (data, size) = deserializeBuffer(buffer: buffer, index: index)
    case .OBJECT:
        print("OBJECT deserialization not implemented")
        size = 0
    }

    return (data, size)
}

func DeserializeAll(buffer: Data) -> [Any?] {
    var data: [Any?] = []
    var index = 0
    while(index < buffer.count) {
        let (deserialized, size) = Deserialize(buffer: buffer, index: index)
        guard size > 0 else { break }
        index += size
        data.append(deserialized)
    }
    return data
}
