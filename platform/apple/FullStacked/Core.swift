import SwiftUI
import WebKit

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

// A call received on a message channel: the response, or nil when the core
// queued it on the frame stream (large responses).
func coreCallMessage(payload: Data) -> Data? {
    var size: Int32 = 0
    let responsePtr = callMessage(payload.ptr(), Int32(payload.count), &size)
    if size < 0 {
        return nil
    }
    guard let responsePtr, size > 0 else {
        return Data()
    }
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

// A request of the page answered by the core (GET /platform, /ctx, /bridge,
// POST /call and /sync, static files, see router.HandleRequest).
func coreRequest(ctx: UInt8, path: String, body: Data) -> (status: Int, mimeType: String, data: Data) {
    var status: Int32 = 0
    var size: Int32 = 0
    let responsePtr = path.withCString { pathPtr in
        body.withUnsafeBytes { bodyPtr in
            handleRequest(ctx, UnsafeMutablePointer(mutating: pathPtr), UnsafeMutableRawPointer(mutating: bodyPtr.baseAddress), Int32(body.count), &status, &size)
        }
    }
    guard let responsePtr else {
        return (500, "text/plain", Data())
    }
    // "<mime type>\n<body>"
    let response = Data(bytesNoCopy: responsePtr, count: Int(size), deallocator: .custom({ ptr, _ in
        freePtr(ptr)
    }))
    let newline = response.firstIndex(of: 10) ?? response.endIndex
    let mimeType = String(decoding: response[..<newline], as: UTF8.self)
    let data = newline < response.endIndex ? response[(newline + 1)...] : Data()
    return (Int(status), mimeType, data)
}

// The fs:// scheme of a page: GET /stream is served here, every other request
// is answered by the core, the calls in order on the core queue of the page.
class RequestHandler: NSObject, WKURLSchemeHandler {
    var ctx: UInt8
    let coreQueue = DispatchQueue(label: "org.fullstacked.core", qos: .userInitiated)
    // the UI endpoints of the page (/open, /exit, /resize), answered by the
    // window on the main thread with a text, nil leaves them to the core (404)
    var ui: ((_ path: String, _ query: [String: String]) -> String?)?
    // main thread only
    private var stoppedTasks = Set<ObjectIdentifier>()
    private var frameStreams: [ObjectIdentifier: (ctx: UInt8, gen: Int32)] = [:]
    
    init(ctx: UInt8) {
        self.ctx = ctx
    }
    
    func reset(ctx: UInt8) {
        self.ctx = ctx
        stoppedTasks.removeAll()
    }
    
    private func respond(_ task: any WKURLSchemeTask, _ url: URL, status: Int, mimeType: String, data: Data) {
        if stoppedTasks.remove(ObjectIdentifier(task as AnyObject)) != nil { return }
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": mimeType,
            "Content-Length": String(data.count),
            "Cache-Control": "no-cache"
        ])!)
        task.didReceive(data)
        task.didFinish()
    }
    
    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        let url = task.request.url!
        let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? url.path
        if path == "/stream" {
            startFrameStream(task, url)
            return
        }
        if path == "/open" || path == "/exit" || path == "/resize" {
            let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            let query = items.reduce(into: [String: String]()) { $0[$1.name] = $1.value ?? "" }
            if let text = ui?(path, query) {
                respond(task, url, status: 200, mimeType: "text/plain", data: Data(text.utf8))
                return
            }
        }
        let ctx = self.ctx
        let body = task.request.httpBody ?? Data()
        let queue = path == "/call" || path == "/sync" ? coreQueue : DispatchQueue.global(qos: .userInitiated)
        queue.async {
            let response = coreRequest(ctx: ctx, path: path.isEmpty ? "/" : path, body: body)
            DispatchQueue.main.async {
                self.respond(task, url, status: response.status, mimeType: response.mimeType, data: response.data)
            }
        }
    }
    
    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        let taskId = ObjectIdentifier(task as AnyObject)
        stoppedTasks.insert(taskId)
        // the page went away, stream data goes back to evaluated chunks
        if let stream = frameStreams.removeValue(forKey: taskId) {
            streamDetach(stream.ctx, stream.gen)
        }
    }
    
    // Stream data of the context as binary frames (see core/internal/frames),
    // read off the main thread and delivered on it until the context ends or
    // the page goes away.
    private func startFrameStream(_ task: any WKURLSchemeTask, _ url: URL) {
        let ctx = self.ctx
        let gen = streamAttach(ctx)
        if gen < 0 {
            respond(task, url, status: 404, mimeType: "text/plain", data: Data("Not Found".utf8))
            return
        }
        let taskId = ObjectIdentifier(task as AnyObject)
        frameStreams[taskId] = (ctx: ctx, gen: gen)
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "application/octet-stream",
            "Cache-Control": "no-cache"
        ])!)
        Thread.detachNewThread { [weak self] in
            while true {
                var size: Int32 = 0
                guard let ptr = streamRead(ctx, gen, &size), size > 0 else { break }
                let data = Data(bytesNoCopy: ptr, count: Int(size), deallocator: .custom({ ptr, _ in
                    freePtr(ptr)
                }))
                DispatchQueue.main.async {
                    guard self?.frameStreams[taskId]?.gen == gen else { return }
                    task.didReceive(data)
                }
            }
            DispatchQueue.main.async {
                guard self?.frameStreams.removeValue(forKey: taskId)?.gen == gen else { return }
                task.didFinish()
            }
        }
    }
}

// Small async calls of the page: the payload in base64, replied with the
// response in base64, or an empty string when the core put a large response
// on the frame stream. Run in order with the other calls of the page.
class CallHandler: NSObject, WKScriptMessageHandlerWithReply {
    weak var requestHandler: RequestHandler?
    
    init(_ requestHandler: RequestHandler) {
        self.requestHandler = requestHandler
    }
    
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? String,
              let payload = Data(base64Encoded: body),
              let requestHandler else {
            replyHandler(nil, "invalid call")
            return
        }
        requestHandler.coreQueue.async {
            let response = coreCallMessage(payload: payload)?.base64EncodedString() ?? ""
            DispatchQueue.main.async {
                replyHandler(response, nil)
            }
        }
    }
}

func coreInit(){
    "apple".withCString { setPlatform(UnsafeMutablePointer(mutating: $0), 1) }
    let cb: @convention(c) (UInt8,
                            UInt8,
                            Int32) -> Void = onStreamDataCallback
    let cbPtr = unsafeBitCast(cb, to: UnsafeMutableRawPointer.self)
    setOnStreamData(cbPtr)
}
