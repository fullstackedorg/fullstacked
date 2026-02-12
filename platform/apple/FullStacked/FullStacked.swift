import SwiftUI

#if os(macOS)
let isMacOS = true
let isIPadOS = false
#else
let isMacOS = false
let isIPadOS = WebViewRepresentable.isIPadOS
#endif

#if targetEnvironment(simulator)
let isSimulator = true
#else
let isSimulator = false
#endif

let EditorColor = 0x1E293B

// source: https://github.com/scottcorgan/contrast/blob/master/index.js
func getBestSuitedColorScheme(c: Int) -> ColorScheme {
    let r = ((c >> 16) & 0xff)
    let g = ((c >>  8) & 0xff)
    let b = ((c      ) & 0xff)
    let o = ((r * 299) + (g * 587) + (b * 114)) / 1000
    return o >= 180 ? .light : .dark
}

let root = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true).first!;
let build = Bundle.main.path(forResource: "app", ofType: nil)!

@main
struct FullStackedApp: App {
    @ObservedObject var webViewStore = WebViewStore()
    
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    let firstCtx = start(root.ptr(), build.ptr())
    
    init() {
        coreInit()
    }

    var body: some Scene {
        Window("FullStacked", id: "fullstacked"){
            ZStack{
                WebViewRepresentable(ctx: self.firstCtx)
                ForEach(webViewStore.webViewsPublished, id: \.self) { webView in
                    Empty()
                        .onAppear{
                            openWindow(id: "window-webview", value: webView.requestHandler.ctx)
                        }
                }
            }
        }
            .defaultSize(width: 700, height: 550)
            .restorationBehavior(.disabled)
        
        WindowGroup(id: "window-webview", for: UInt8.self) { $ctx in
            if ctx != nil {
                WebViewRepresentable(ctx: ctx!)
                    .onDisappear{
                        self.webViewStore.removeWebView(ctx: ctx!)
                    }
            } else {
                WebViewRepresentable(ctx: start(root.ptr(), build.ptr()))
            }
        }
            .defaultSize(width: 700, height: 550)
            .restorationBehavior(.disabled)
    }
}

struct Empty: View {
    var body: some View {
        Rectangle()
            .hidden()
    }
}


class WebViewStore: ObservableObject {
    static var singleton: WebViewStore?;
    var webViews: [WebView] = [];
    @Published var webViewsPublished: [WebView] = []
        
    init(){
        WebViewStore.singleton = self
    }
    
    func addWebView(ctx: UInt8) {
        let webView = WebView(ctx: ctx)
        self.webViewsPublished.append(webView)
    }
    
    func getWebView(ctx: UInt8) -> WebView? {
        if let webView = webViewsPublished.first(where: { $0.requestHandler.ctx == ctx }) {
            return webView
        }
        
        if let webView = webViews.first(where: { $0.requestHandler.ctx == ctx }) {
            return webView
        }
        
        return nil
    }
    
    func getOrCreateWebView(ctx: UInt8) -> WebView {
        if let webView = self.getWebView(ctx: ctx) {
            return webView
        }
        
        let webView = WebView(ctx: ctx)
        self.webViews.append(webView)
        
        return webView
    }
    
    func removeWebView(ctx: UInt8) {
        webViewsPublished.removeAll(where: { $0.requestHandler.ctx == ctx })
        webViews.removeAll(where: { $0.requestHandler.ctx == ctx })
        stop(ctx)
    }
}
