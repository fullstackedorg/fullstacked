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
    
    @ObservedObject var webViewStore = WebViewStore.getInstance()
    
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows
    
    init() {
        coreInit()
    }

    var body: some Scene {
        WindowGroup(id: "FullStacked", for: WebView.ID.self) { $id in
            ZStack {
                WebViewRepresentable(self.webViewStore.getOrCreate(id))
                    .ignoresSafeArea()
                    .onAppear{
                        if(self.supportsMultipleWindows) {
                            self.webViewStore.openWindow = self.openWindow
                        }
                    }
                    .onDisappear{
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                            self.webViewStore.removeWebView(id)
                       }
                    } 
                
                if(self.webViewStore.getOrCreate(id).main) {
                    ForEach(self.webViewStore.webViewsPublished, id: \.self) { webView in
                        VStack {
                            HStack(alignment: .center) {
                                Button {
                                    self.webViewStore.removeWebView(webView.id)
                                } label: {
                                    Image(systemName: "xmark")
                                }
                                .frame(maxWidth: .infinity, alignment: .trailing)
                                .padding(EdgeInsets(top: 2, leading: 0, bottom: 2, trailing: 10))
                            }
                            WebViewRepresentable(webView)
                                .ignoresSafeArea()
                        }
                            .background(Color(red: 1.0, green: 1.0, blue: 1.0))
                    }
                }
            }
        } defaultValue: {
            UUID()
        }
        #if os(macOS)
            .defaultSize(width: 700, height: 550)
            .restorationBehavior(.disabled)
        #endif
    }
}

class WebViewStore: ObservableObject {
    static private var singleton: WebViewStore?;
    static func getInstance() -> WebViewStore {
        if(self.singleton == nil) {
            self.singleton = WebViewStore()
        }
        
        return self.singleton!
    }
    
    var openWindow: OpenWindowAction?
    
    var webViews: [WebView] = []
    @Published var webViewsPublished: [WebView] = []
    
    func addWebView(_ webView: WebView) {
        self.webViews.append(webView)
        if let openWindow = self.openWindow {
            openWindow(id: "FullStacked", value: webView.id)
        } else {
            self.webViewsPublished.append(webView)
        }
    }
    
    func getOrCreate(_ id: UUID) -> WebView {
        if let webView = self.webViews.first(where: { $0.id == id }) {
            return webView
        }
        
        let webView = WebView(nil)
        webView.id = id
        self.webViews.append(webView)
        return webView
    }
    
    func removeWebView(_ id: UUID){
        if let index = self.webViewsPublished.firstIndex(where: { $0.id == id }) {
            self.webViewsPublished.remove(at: index).close()
        }
        if let index = self.webViews.firstIndex(where: { $0.id == id }) {
            self.webViews.remove(at: index).close()
        }
    }
}
