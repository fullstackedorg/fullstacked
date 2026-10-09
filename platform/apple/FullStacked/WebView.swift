import WebKit
import SwiftUI
import AuthenticationServices

let platform = "apple"
let downloadDirectory = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first! + "/downloads";

func startMain(_ providedCtx: UInt8?, _ safe: Bool?) -> UInt8 {
    let rootPtr = root.ptr()
    let buildPtr = build.ptr()
    
    var ctx: UInt8
    if(safe == true) {
        ctx = startSafe(rootPtr, buildPtr)
    } else if(providedCtx == nil) {
        ctx = start(rootPtr, buildPtr)
    } else {
        startWithCtx(rootPtr, buildPtr, providedCtx!)
        ctx = providedCtx!
    }
    
    rootPtr?.deallocate()
    buildPtr?.deallocate()
    
    return ctx
}

class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: (AnyObject & WKScriptMessageHandler)?
    init(_ target: AnyObject & WKScriptMessageHandler) {
        self.target = target
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
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

class WebViewOpen: NSObject, WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let ctx = UInt8(truncating: message.body as! NSNumber)
        WebViewStore.getInstance().addWebView(WebView(ctx))
    }
}

class WebViewCloser: NSObject, WKScriptMessageHandler {
    weak var webView: WebView?
    
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let id = self.webView?.id {
            WebViewStore.getInstance().removeWebView(id)
            self.webView?.close()
        }
    }
}

class WebView: WebViewExtended, WKNavigationDelegate, WKDownloadDelegate, Codable, Identifiable, ASWebAuthenticationPresentationContextProviding {
    
    var id = UUID()
    let open = WebViewOpen();
    let closer = WebViewCloser();
    
    public let requestHandler: RequestHandler
    
    public var isSafe = false
    
    // responses and stream chunks received between two main thread ticks are
    // evaluated in one script
    private let scriptLock = NSLock()
    private var pendingScript = ""
    private var scriptFlushScheduled = false
    
    required init(from decoder: any Decoder) throws {
        fatalError("init(coder:) has not been implemented")
    }
    func encode(to encoder: any Encoder) throws {
        
    }
    
    init(dummy: Bool) {
        self.isSafe = false
        self.requestHandler = RequestHandler(ctx: 0)
        let wkWebViewConfig = WKWebViewConfiguration()
        super.init(frame: CGRect(), configuration: wkWebViewConfig)
    }

    init(_ providedCtx: UInt8?, safe: Bool = false) {
        self.isSafe = safe
        
        let ctx = providedCtx ?? startMain(nil, safe)
        
        if check(ctx) == 0 {
            _ = startMain(ctx, safe)
        }
        
        self.requestHandler = RequestHandler(ctx: ctx)
        
        // inspector / debug console
        let wkWebViewConfig = WKWebViewConfiguration()
        wkWebViewConfig.preferences.setValue(true, forKey: "developerExtrasEnabled")
        wkWebViewConfig.preferences.javaScriptCanOpenWindowsAutomatically = true
        
        let userContentController = WKUserContentController()
        wkWebViewConfig.userContentController = userContentController
        wkWebViewConfig.setURLSchemeHandler(self.requestHandler, forURLScheme: "fs")
        
        super.init(frame: CGRect(), configuration: wkWebViewConfig)
        
        self.closer.webView = self
        
        self.isInspectable = true
        self.navigationDelegate = self
        userContentController.addScriptMessageHandler(CallHandler(self.requestHandler), contentWorld: .page, name: "call")
        userContentController.add(WeakMessageHandler(self.open), name: "open")
        userContentController.add(WeakMessageHandler(self.closer), name: "exit")
        
        self.load(URLRequest(url: URL(string: "fs://localhost")!))
    }
    
    func switchToSafeMode() {
        self.isSafe = true
        self.stopLoading()
        stop(self.requestHandler.ctx)
        let safeCtx = startMain(nil, true)
        self.requestHandler.reset(ctx: safeCtx)
        self.load(URLRequest(url: URL(string: "fs://localhost")!, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
    }
    
    override func close(){
        self.isInspectable = false
        self.stopLoading()
        self.loadHTMLString("", baseURL: nil)
        self.removeFromSuperview()
        self.navigationDelegate = nil
        self.configuration.userContentController.removeScriptMessageHandler(forName: "open")
        self.configuration.userContentController.removeScriptMessageHandler(forName: "exit")
        self.configuration.userContentController.removeAllUserScripts()
        self.configuration.userContentController.removeAllScriptMessageHandlers()
        stop(self.requestHandler.ctx)
        self.closer.webView = nil
        super.close()
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func onStreamData(streamId: UInt8, buffer: Data){
        queueScript("window.fullstacked.onStreamData(\(streamId),`\(buffer.base64EncodedString())`)")
    }
    
    // a statement that throws does not stop the others of the batch
    private func queueScript(_ statement: String) {
        scriptLock.lock()
        pendingScript.append("try{\(statement)}catch(e){console.error(e)};")
        let schedule = !scriptFlushScheduled
        scriptFlushScheduled = true
        scriptLock.unlock()
        
        if schedule {
            DispatchQueue.main.async { [weak self] in
                self?.flushScripts()
            }
        }
    }
    
    private func flushScripts() {
        scriptLock.lock()
        let script = pendingScript
        pendingScript = ""
        scriptFlushScheduled = false
        scriptLock.unlock()
        
        if !script.isEmpty {
            self.evaluateJavaScript(script)
        }
    }
    
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        return self.window ?? ASPresentationAnchor()
    }
    
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
                
        if let url = navigationAction.request.url {
            var urlComponents = URLComponents(url: url, resolvingAgainstBaseURL: false)
            if (urlComponents?.queryItems?.first(where: { $0.name == "auth" })?.value) != nil {
                urlComponents?.queryItems?.append(URLQueryItem(name: "native", value: "1"))
                // answer on fullstacked-auth://, fullstacked:// carries deeplinks (onOpenURL)
                urlComponents?.queryItems?.append(URLQueryItem(name: "callback_scheme", value: "fullstacked-auth"))

                let authUrl = urlComponents?.url!
                // Initialize the session.
                let session = ASWebAuthenticationSession(url: authUrl!, callbackURLScheme: "fullstacked-auth")
                { callbackURL, error in
                    DispatchQueue.main.async {
                        if(error != nil) {
                            self.evaluateJavaScript("window.postMessage(new Error(`Authentication Canceled`), \"*\")")
                        } else {
                            self.evaluateJavaScript("window.postMessage(Object.fromEntries(new URLSearchParams(`\(callbackURL?.query() ?? "")`)), \"*\")")
                        }
                    }
                }
                session.presentationContextProvider = self
                session.start()
            }
        }
        
        return nil
    }
    
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if(navigationAction.shouldPerformDownload) {
            decisionHandler(.download)
        } else if navigationAction.navigationType == .linkActivated  {
            if let url = navigationAction.request.url, "localhost" != url.host {
                self.openBrowserURL(url)
                decisionHandler(.cancel)
            } else {
                decisionHandler(.allow)
            }
        } else {
            decisionHandler(.allow)
        }
    }
    
    func webView(_ webView: WKWebView, didFinish didFinishNavigation: WKNavigation) {
        var title = webView.title
        if(title == nil || title!.isEmpty) {
            title = "FullStacked"
        }
        WebViewStore.getInstance().webViewsMeta[self.id] = (title!, self.getBackgroundColor())
    }
    
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }
        
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }
    
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping @MainActor @Sendable (URL?) -> Void) {
        try! FileManager.default.createDirectory(at: URL(fileURLWithPath: downloadDirectory), withIntermediateDirectories: true)
        let downloadPath = downloadDirectory + "/" + suggestedFilename
        
        if(FileManager.default.fileExists(atPath: downloadPath)) {
            try! FileManager.default.removeItem(atPath: downloadPath)
        }
        
        let url = URL(fileURLWithPath: downloadPath)
        completionHandler(url)
    }
    
    func downloadDidFinish(_ download: WKDownload) {
        self.openDownloadDirectory()
    }
    
    func getBackgroundColor() -> Color {
        return Color(self.underPageBackgroundColor.cgColor)
    }
}


class RequestHandler: NSObject, WKURLSchemeHandler {
    var ctx: UInt8
    // core calls of this webview run in order, off the main thread
    let coreQueue = DispatchQueue(label: "org.fullstacked.core", qos: .userInitiated)
    private var stoppedTasks = Set<ObjectIdentifier>()
    private let tasksLock = NSLock()
    // GET /stream tasks and their reader generation, main thread only
    private var frameStreams: [ObjectIdentifier: (ctx: UInt8, gen: Int32)] = [:]
    
    init(ctx: UInt8) {
        self.ctx = ctx
    }
    
    func reset(ctx: UInt8) {
        self.ctx = ctx
        tasksLock.lock()
        stoppedTasks.removeAll()
        tasksLock.unlock()
    }
    
    func send(urlSchemeTask: WKURLSchemeTask,
              url: URL,
              statusCode: Int,
              mimeType: String,
              data: Data) {
        tasksLock.lock()
        let isStopped = stoppedTasks.contains(ObjectIdentifier(urlSchemeTask as AnyObject))
        tasksLock.unlock()
        if isStopped { return }
        
        let responseHTTP = HTTPURLResponse(
            url: url,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mimeType,
                "Content-Length": String(data.count),
                "Cache-Control": "no-cache"
            ]
        )!
        
        urlSchemeTask.didReceive(responseHTTP)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }
    
    func webView(_ webView: WKWebView, start urlSchemeTask: any WKURLSchemeTask) {
        let request = urlSchemeTask.request
        var pathname = request.url!.pathComponents.filter({$0 != "/"}).joined(separator: "/")
        
        if(pathname.isEmpty) {
            pathname = "/"
        }
        
        if(pathname == "platform") {
            let data = platform.data(using: .utf8)!
            self.send(urlSchemeTask: urlSchemeTask,
                      url: request.url!,
                      statusCode: 200,
                      mimeType: "text/plain",
                      data: data)
            return
        } else if (pathname == "ctx") {
            self.send(urlSchemeTask: urlSchemeTask,
                      url: request.url!,
                      statusCode: 200,
                      mimeType: "text/plain",
                      data: Data(String(self.ctx).utf8))
            return
        } else if (pathname == "stream") {
            self.startFrameStream(urlSchemeTask: urlSchemeTask, url: request.url!)
            return
        } else if (pathname == "stream/detach") {
            // the page did not get the hello frame, it keeps the evaluated chunks
            streamDetach(self.ctx, 0)
            self.send(urlSchemeTask: urlSchemeTask,
                      url: request.url!,
                      statusCode: 200,
                      mimeType: "text/plain",
                      data: Data())
            return
        } else if (pathname == "bridge") {
            // the page posts its calls to /call and /sync
            self.send(urlSchemeTask: urlSchemeTask,
                      url: request.url!,
                      statusCode: 200,
                      mimeType: "text/plain",
                      data: Data("binary".utf8))
            return
        } else if (pathname == "call" || pathname == "sync") {
            // the body is the payload, the response the core response; sync is
            // a sync XHR of the page, the same for the host
            let payload = request.httpBody ?? Data()
            coreQueue.async {
                let response = coreCall(payload: payload)
                DispatchQueue.main.async {
                    self.send(urlSchemeTask: urlSchemeTask,
                              url: request.url!,
                              statusCode: 200,
                              mimeType: "application/octet-stream",
                              data: response)
                }
            }
            return
        }
        
        // static file serving, read off the main thread, respond on it
        
        let pathnameData = pathname.data(using: .utf8)!
        var payload = Data([
            self.ctx,
            0, // req id, unused by callWithResponse
            0, // Core Module
            0, // Fn Static File
            0, // Async
            
            SerializableDataType.STRING.rawValue,
        ])
        payload.append(NumberToUint4Bytes(num: pathnameData.count))
        payload.append(pathnameData)
        
        DispatchQueue.global(qos: .userInitiated).async {
            let response = RequestHandler.staticFileResponse(coreCall(payload: payload))
            DispatchQueue.main.async {
                self.send(urlSchemeTask: urlSchemeTask,
                          url: request.url!,
                          statusCode: response.statusCode,
                          mimeType: response.mimeType,
                          data: response.data)
            }
        }
    }
    
    // Stream data of the context as binary frames (see core/internal/frames),
    // read off the main thread and delivered on it until the context ends or
    // the page goes away.
    func startFrameStream(urlSchemeTask: any WKURLSchemeTask, url: URL) {
        let ctx = self.ctx
        let gen = streamAttach(ctx)
        if gen < 0 {
            send(urlSchemeTask: urlSchemeTask,
                 url: url,
                 statusCode: 404,
                 mimeType: "text/plain",
                 data: "Not Found".data(using: .utf8)!)
            return
        }
        
        let taskId = ObjectIdentifier(urlSchemeTask as AnyObject)
        frameStreams[taskId] = (ctx: ctx, gen: gen)
        
        urlSchemeTask.didReceive(HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "application/octet-stream",
                "Cache-Control": "no-cache"
            ]
        )!)
        
        Thread.detachNewThread { [weak self] in
            while true {
                var size: Int32 = 0
                guard let ptr = streamRead(ctx, gen, &size), size > 0 else { break }
                let data = Data(bytesNoCopy: ptr, count: Int(size), deallocator: .custom({ ptr, _ in
                    freePtr(ptr)
                }))
                DispatchQueue.main.async {
                    guard self?.frameStreams[taskId]?.gen == gen else { return }
                    urlSchemeTask.didReceive(data)
                }
            }
            DispatchQueue.main.async {
                guard self?.frameStreams.removeValue(forKey: taskId)?.gen == gen else { return }
                urlSchemeTask.didFinish()
            }
        }
    }
    
    static func staticFileResponse(_ responseData: Data) -> (statusCode: Int, mimeType: String, data: Data) {
        let notFound = (statusCode: 404, mimeType: "text/plain", data: "Not Found".data(using: .utf8)!)
        guard responseData.count > 1 else {
            return notFound
        }
        let (response, _) = Deserialize(buffer: responseData, index: 1)
        guard let responseDataPayload = response as? Data else {
            return notFound
        }
        let args = DeserializeAll(buffer: responseDataPayload)
        
        guard args.count >= 2, let mimeType = args[0] as? String, let fileData = args[1] as? Data else {
            return notFound
        }
        
        return (statusCode: 200, mimeType: mimeType, data: fileData)
    }
    
    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) {
        let taskId = ObjectIdentifier(urlSchemeTask as AnyObject)
        tasksLock.lock()
        stoppedTasks.insert(taskId)
        tasksLock.unlock()
        
        // the page went away, stream data goes back to evaluated chunks
        if let stream = frameStreams.removeValue(forKey: taskId) {
            streamDetach(stream.ctx, stream.gen)
        }
    }
}

extension String {
    func ptr() -> UnsafeMutablePointer<CChar>? {
        return strdup(self)
    }
}

extension Data {
    func ptr() -> UnsafeMutableRawPointer? {
        return UnsafeMutableRawPointer(mutating: (self as NSData).bytes)
    }
    
    func print(){
        var str = "["
        for i in 0...(self.count - 1) {
            str += String(self[self.startIndex + i])
            if(i < self.count - 1){
                str += ", "
            } else {
                str += "]"
            }
        }
        Swift.print(str)
    }
}
