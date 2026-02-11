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

@main
struct FullStackedApp: App {
    @ObservedObject var webViewStore = WebViewStore()

    var body: some Scene {
        WindowGroup("FullStacked"){
            ZStack{
                ForEach(webViewStore.webViews, id: \.self) { webView in //
                    WebViewRepresentable(webView: webView)
                }
            }
            .onAppear(){
                coreInit()
                webViewStore.addWebView(directory: Bundle.main.path(forResource: "app", ofType: nil)!)
            }
        }
    }
}


class WebViewStore: ObservableObject {
    static var singleton: WebViewStore?;
    @Published var webViews: [WebView] = []
    
    init(){
        WebViewStore.singleton = self
    }
    
    func addWebView(directory: String) {
        let webView = WebView(directory: directory)
        webViews.append(webView)
    }
    
    func getWebView(ctx: UInt8) -> WebView? {
        return webViews.first(where: { $0.requestHandler.ctx == ctx })
    }
}
