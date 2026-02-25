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
func getBestSuitedColorScheme(color: Color?) -> ColorScheme? {
    if color == nil {
        return nil
    }
    
    let c = color!.hex()
    
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
    
    @State private var windowSize: CGSize = .zero
    
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows
    
    init() {
        coreInit()
    }

    var body: some Scene {
        WindowGroup(id: "FullStacked", for: WebView.ID.self) { $id in
            (self.webViewStore.webViewsMeta[id]?.1 ?? Color(hex: 0))
                .navigationTitle(self.webViewStore.webViewsMeta[id]?.0 ?? "FullStacked")
            
                .onGeometryChange(for: CGSize.self) { proxy in
                    proxy.size
                } action: { newSize in
                    self.windowSize = newSize
                }
            
                .overlay {
                    NavigationStack {
                        ZStack {
                            WebViewRepresentable(self.webViewStore.getOrCreate(id))
                                .ignoresSafeArea()
                                .background(self.webViewStore.webViewsMeta[id]?.1)
                                .navigationTitle(self.webViewStore.webViewsMeta[id]?.0 ?? "FullStacked")
                            
                            #if os(macOS)
                                .preferredColorScheme(getBestSuitedColorScheme(color: self.webViewStore.webViewsMeta[id]?.1))
                                .padding(EdgeInsets(top: 1, leading: 0, bottom: 0, trailing: 0))
                                .toolbar{
                                    Spacer()
                                }
                                .toolbarBackground(self.webViewStore.webViewsMeta[id]?.1 ?? Color(red: 0, green: 0, blue: 0, opacity: 0))
                            #else
                                .preferredColorScheme(isIPadOS
                                                      ? getBestSuitedColorScheme(color: self.webViewStore.webViewsMeta[id]?.1)
                                                      : nil)
                                .toolbar(
                                    isIPadOS && !isFullScreen(size: self.windowSize) ? .visible : .hidden,
                                    for: .navigationBar)
                                .navigationBarTitleDisplayMode(.inline)
                            #endif
                                
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
                                                    .tint(getBestSuitedColorScheme(color: self.webViewStore.webViewsMeta[webView.id]?.1) == .dark
                                                          ? .white
                                                          : .black)
                                            }
                                            .frame(maxWidth: .infinity, alignment: .trailing)
                                            .padding(windowSize.width > windowSize.height
                                                     ? EdgeInsets(top: 10, leading: 0, bottom: 2, trailing: 10)
                                                     : EdgeInsets(top: 2, leading: 0, bottom: 2, trailing: 10))
                                                
                                        }
                                        WebViewRepresentable(webView)
                                            .ignoresSafeArea()
                                            
                                    }
                                    .background(self.webViewStore.webViewsMeta[webView.id]?.1 ?? Color(.black))
                                    .preferredColorScheme(getBestSuitedColorScheme(color: self.webViewStore.webViewsMeta[webView.id]?.1))
                                }
                            }
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
    
    init() {
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true, block: { _ in
            self.webViews.forEach { webView in
                var title = webView.title
                if(title == nil || title!.isEmpty) {
                    title = "FullStacked"
                }
                
                self.webViewsMeta[webView.id] =
                    (title!, webView.getBackgroundColor())
            }
        })
    }
    
    var openWindow: OpenWindowAction?
    
    var webViews: [WebView] = []
    @Published var webViewsPublished: [WebView] = []
    // title, bgColor
    @Published var webViewsMeta: [UUID:(String, Color)] = [:]
    
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

extension Color {
    init(hex: Int, opacity: Double = 1.0) {
        let red = Double((hex & 0xff0000) >> 16) / 255.0
        let green = Double((hex & 0xff00) >> 8) / 255.0
        let blue = Double((hex & 0xff) >> 0) / 255.0
        self.init(.sRGB, red: red, green: green, blue: blue, opacity: opacity)
    }
}
