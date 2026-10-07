import SwiftUI

private let coreCallLock = NSLock()

func coreCall(payload: Data) -> Data {
    coreCallLock.lock()
    defer { coreCallLock.unlock() }
    
    let responseLength = call(payload.ptr(), Int32(payload.count))
    if responseLength <= 0 {
        return Data()
    }
    let responsePtr = UnsafeMutableRawPointer.allocate(byteCount: Int(responseLength), alignment: 1)
    getCorePayload(payload[0], 1, payload[1], responsePtr, responseLength)
    let response = Data(bytes: responsePtr, count: Int(responseLength))
    responsePtr.deallocate()
    return response
}

// Calls Core Fn DeepLink in ctx: the deeplink plugins of ctx receive url.
// Returns how many plugins were called.
func coreDeepLink(ctx: UInt8, url: String) -> Int {
    let urlData = url.data(using: .utf8)!
    var payload = Data([
        ctx,
        RequestHandler.getNextReqId(), // req id
        0, // Core Module
        6, // Fn DeepLink
        0, // Async
        
        SerializableDataType.STRING.rawValue,
    ])
    payload.append(NumberToUint4Bytes(num: urlData.count))
    payload.append(urlData)
    
    let responseData = coreCall(payload: payload)
    guard responseData.count > 1 else { return 0 }
    let (count, _) = Deserialize(buffer: responseData, index: 1)
    if let count = count as? Double { return Int(count) }
    if let count = count as? Int { return count }
    return 0
}

func onStreamDataCallback(
    ctx: UInt8,
    streamId: UInt8,
    size: Int32
){
    if let webView = WebViewStore.getInstance().webViews.first(where: {$0.requestHandler.ctx == ctx}) {
        let bufferPtr = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 1)
        getCorePayload(ctx, 2, streamId, bufferPtr, size)
        let buffer = Data(bytes: bufferPtr, count: Int(size))
        webView.onStreamData(streamId: streamId, buffer: buffer)
        bufferPtr.deallocate()
    } else {
        print("[onStreamData] Unknown ctx")
    }
}

func coreInit(){
    let cb: @convention(c) (UInt8,
                            UInt8,
                            Int32) -> Void = onStreamDataCallback
    let cbPtr = unsafeBitCast(cb, to: UnsafeMutableRawPointer.self)
    setOnStreamData(cbPtr)
}
