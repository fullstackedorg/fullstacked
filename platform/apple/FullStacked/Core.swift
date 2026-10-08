import SwiftUI

// Thread safe: the core synchronizes per context, responses are returned
// directly instead of being stored by request id.
func coreCall(payload: Data) -> Data {
    var size: Int32 = 0
    let responsePtr = callWithResponse(payload.ptr(), Int32(payload.count), &size)
    guard let responsePtr, size > 0 else {
        return Data()
    }
    // the core allocated the response, free it with the core once released
    return Data(bytesNoCopy: responsePtr, count: Int(size), deallocator: .custom({ ptr, _ in
        freePtr(ptr)
    }))
}

// Calls Core Fn DeepLink in ctx: the deeplink plugins of ctx receive url.
// Returns how many plugins were called.
func coreDeepLink(ctx: UInt8, url: String) -> Int {
    let urlData = url.data(using: .utf8)!
    var payload = Data([
        ctx,
        0, // req id, unused by callWithResponse
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
        var buffer = Data(count: Int(size))
        buffer.withUnsafeMutableBytes { bytes in
            getCorePayload(ctx, 2, streamId, bytes.baseAddress, size)
        }
        webView.onStreamData(streamId: streamId, buffer: buffer)
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
