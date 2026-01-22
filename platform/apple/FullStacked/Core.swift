import SwiftUI

func coreCall(payload: Data) -> Data{
    let responseLength = call(payload.ptr(), Int32(payload.count))
    let responsePtr = UnsafeMutableRawPointer.allocate(byteCount: Int(responseLength), alignment: 1)
    getCorePayload(payload[0], 1, payload[1], responsePtr)
    let response = Data(bytes: responsePtr, count: Int(responseLength))
    responsePtr.deallocate()
    return response
}
