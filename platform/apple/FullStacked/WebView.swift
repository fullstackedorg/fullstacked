import WebKit
import SwiftUI
import AuthenticationServices

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

class WebView: WebViewExtended, WKNavigationDelegate, WKDownloadDelegate, Codable, Identifiable, ASWebAuthenticationPresentationContextProviding {
    
    var id = UUID()
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
        
        self.isInspectable = true
        self.navigationDelegate = self
        userContentController.addScriptMessageHandler(CallHandler(self.requestHandler), contentWorld: .page, name: "call")
        // the UI endpoints of the page, see bridge/platform.ts
        self.requestHandler.ui = { [weak self] path, query in
            guard let self = self else { return nil }
            switch path {
            case "/open":
                if let ctx = query["ctx"].flatMap({ UInt8($0) }) {
                    WebViewStore.getInstance().addWebView(WebView(ctx))
                }
                return ""
            case "/exit":
                // answered first, closing stops the pending tasks
                DispatchQueue.main.async {
                    WebViewStore.getInstance().removeWebView(self.id)
                    self.close()
                }
                return ""
            default:
                return self.resizeRequest(query["size"])
            }
        }
        
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
        self.configuration.userContentController.removeAllUserScripts()
        self.configuration.userContentController.removeAllScriptMessageHandlers()
        stop(self.requestHandler.ctx)
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
