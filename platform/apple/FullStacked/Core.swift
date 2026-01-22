import SwiftUI

func coreCall(payload: Data) -> Data{
    let responseLength = call(payload.ptr(), Int32(payload.count))
    let responsePtr = UnsafeMutableRawPointer.allocate(byteCount: Int(responseLength), alignment: 1)
    getCorePayload(payload[0], 1, payload[1], responsePtr)
    let response = Data(bytes: responsePtr, count: Int(responseLength))
    responsePtr.deallocate()
    return response
}

func onStreamDataCallback(
    ctx: UInt8,
    streamId: UInt8,
    size: Int32
){
    let bufferPtr = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 1)
    getCorePayload(ctx, 2, streamId, bufferPtr)
    let buffer = Data(bytes: bufferPtr, count: Int(size))
    if let webView = WebViewStore.singleton?.getWebView(ctx: ctx) {
        webView.onStreamData(streamId: streamId, buffer: buffer)
    }
    bufferPtr.deallocate()
}

func coreInit(){
    let cb: @convention(c) (UInt8,
                            UInt8,
                            Int32) -> Void = onStreamDataCallback
    let cbPtr = unsafeBitCast(cb, to: UnsafeMutableRawPointer.self)
    setOnStreamData(cbPtr)
}
