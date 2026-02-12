import WebKit

let platform = "apple"
let downloadDirectory = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first! + "/downloads";

class WebView: WebViewExtended, WKNavigationDelegate, WKScriptMessageHandler, WKDownloadDelegate {
    public let requestHandler: RequestHandler
    
    init(ctx: UInt8) {
        self.requestHandler = RequestHandler(ctx: ctx)
        
        // inspector / debug console
        let wkWebViewConfig = WKWebViewConfiguration()
        wkWebViewConfig.preferences.setValue(true, forKey: "developerExtrasEnabled")
        
        let userContentController = WKUserContentController()
        wkWebViewConfig.userContentController = userContentController
        wkWebViewConfig.setURLSchemeHandler(self.requestHandler, forURLScheme: "fs")
        
        super.init(frame: CGRect(), configuration: wkWebViewConfig)
        
        
        self.isInspectable = true
        self.navigationDelegate = self
        userContentController.add(self, name: "bridge")
        
        self.load(URLRequest(url: URL(string: "fs://localhost")!))
    }
    
    func close(){
        self.navigationDelegate = nil
        self.configuration.userContentController.removeScriptMessageHandler(forName: "bridge")
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func onStreamData(streamId: UInt8, buffer: Data){
        DispatchQueue.main.async {
            self.evaluateJavaScript("window.callback(\(streamId),`\(buffer.base64EncodedString())`)")
        }
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
    
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let payload = Data(base64Encoded: message.body as! String)!
        let response = coreCall(payload: payload)
        
        // Sync
        if(payload[payload.startIndex + 4] == 1) {
            let id = payload[payload.startIndex + 1]
            self.requestHandler.resolveSyncAwaiter(id: id, payload: response)
        }
        // Async
        else {
            self.evaluateJavaScript("window.respond(\(payload[payload.startIndex + 1]),`\(response.base64EncodedString())`)")
        }
    }
    
    func webView(_ webView:WKWebView, didFinish didFinishNavigation: WKNavigation){
//        let wkSnapConfig = WKSnapshotConfiguration()
//        wkSnapConfig.rect = CGRect(x: 0, y: 0, width: 1, height: 1)
//        takeSnapshot(with: wkSnapConfig) { image, err in
//            if(err != nil) {
//                print(err!)
//                return
//            }
//            self.snapshotImageToWindowColor(projectId: self.requestHandler.instance.id, image: image!)
//        }
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
}


class RequestHandler: NSObject, WKURLSchemeHandler {
    let ctx: UInt8
    private var syncAwaitersResolve: [UInt8:((_ payload: Data) -> Void)] = [:]
    private var syncAwaitersPayload: [UInt8:Data] = [:]
    
    init(ctx: UInt8) {
        self.ctx = ctx
    }
    
    func resolveSyncAwaiter(id: UInt8, payload: Data) {
        if let resolve = syncAwaitersResolve[id] {
            resolve(payload)
            syncAwaitersResolve.removeValue(forKey: id)
        } else {
            syncAwaitersPayload[id] = payload
        }
    }
    
    func send(urlSchemeTask: WKURLSchemeTask,
              url: URL,
              statusCode: Int,
              mimeType: String,
              data: Data) {
        
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
        
        print(pathname)
        
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
        } else if (pathname.starts(with: "sync")) {
            let idStr = pathname.split(separator: "/").last!
            let id = UInt8(idStr)!
            
            let sendCallback = {(payload: Data) -> Void in
                DispatchQueue.main.async {
                    self.send(
                        urlSchemeTask: urlSchemeTask,
                        url: request.url!,
                        statusCode: 200,
                        mimeType: "application/octet-stream",
                        data: payload.base64EncodedData()
                    )
                }
            }
            
            if let payload = self.syncAwaitersPayload[id] {
                sendCallback(payload)
                self.syncAwaitersPayload.removeValue(forKey: id)
            } else {
                self.syncAwaitersResolve[id] = sendCallback
            }
            
            return
        }
        
        // static file serving
        
        let pathnameData = pathname.data(using: .utf8)!
        var payload = Data([
            self.ctx,
            0, // req id
            0, // Core Module
            0, // Fn Static File
            0, // Async
            
            SerializableDataType.STRING.rawValue,
        ])
        payload.append(NumberToUint4Bytes(num: pathnameData.count))
        payload.append(pathnameData)
        
        let responseData = coreCall(payload: payload)
        let (response, _) = Deserialize(buffer: responseData, index: 1)
        let args = DeserializeAll(buffer: response as! Data)
        
        if(args.count < 2 || args[0] == nil) {
            send(urlSchemeTask: urlSchemeTask,
                 url: request.url!,
                 statusCode: 404,
                 mimeType: "text/plain",
                 data: "Not Found".data(using: .utf8)!)
            return
        }
        
        send(urlSchemeTask: urlSchemeTask,
             url: request.url!,
             statusCode: 200,
             mimeType: args[0] as! String,
             data: args[1] as! Data)
    }
    
    func webView(_ webView: WKWebView, stop urlSchemeTask: any WKURLSchemeTask) { }
}

extension String {
    func ptr() -> UnsafeMutableRawPointer? {
        return Data(self.utf8).ptr()
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


