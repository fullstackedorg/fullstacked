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
let build = Bundle.main.path(forResource: "out", ofType: nil)!

@main
struct FullStackedApp: App {
    
    @ObservedObject var webViewStore = WebViewStore.getInstance()
    
    @State private var windowSize: CGSize = .zero
    
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.supportsMultipleWindows) private var supportsMultipleWindows
    
    init() {
        coreInit()
    }

    var body: some Scene {
        WindowGroup(id: "FullStacked", for: WebView.ID.self) { $id in
            #if os(iOS)
            let isFull = isFullScreen(size: self.windowSize, windowScene: self.webViewStore.getScene(for: id))
            #else
            let isFull = true
            #endif
            
            (self.webViewStore.webViewsMeta[id]?.1 ?? Color(hex: 0))
                .ignoresSafeArea()
                .navigationTitle(self.webViewStore.webViewsMeta[id]?.0 ?? "FullStacked")
            
                .onGeometryChange(for: CGSize.self) { proxy in
                    proxy.size
                } action: { newSize in
                    self.windowSize = newSize
                }
            
                .overlay {
                    NavigationStack {
                        ZStack {
                            (self.webViewStore.webViewsMeta[id]?.1 ?? Color(hex: 0))
                                .ignoresSafeArea()
                            
                            if self.supportsMultipleWindows {
                                WebViewRepresentable(self.webViewStore.getOrCreate(id))
                                    .id(id)
                                    #if os(iOS)
                                    .ignoresSafeArea(edges: .bottom)
                                    #else
                                    .ignoresSafeArea()
                                    #endif
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
                                        isIPadOS && !isFull ? .visible : .hidden,
                                        for: .navigationBar)
                                    .toolbarBackground(self.webViewStore.webViewsMeta[id]?.1 ?? Color(hex: 0), for: .navigationBar)
                                    .navigationBarTitleDisplayMode(.inline)
                                #endif
                            } else {
                                ForEach(self.webViewStore.webViewsPublished, id: \.id) { webView in
                                    VStack {
                                        if self.webViewStore.webViewsPublished.count > 1 {
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
                                        }
                                        
                                        WebViewRepresentable(webView)
                                            .id(webView.id)
                                            #if os(iOS)
                                            .ignoresSafeArea(edges: .bottom)
                                            #else
                                            .ignoresSafeArea()
                                            #endif
                                    }
                                    .background(self.webViewStore.webViewsMeta[webView.id]?.1 ?? Color(.black))
                                    .preferredColorScheme(getBestSuitedColorScheme(color: self.webViewStore.webViewsMeta[webView.id]?.1))
                                }
                            }
                        }
                        .onAppear{
                            if(self.supportsMultipleWindows) {
                                self.webViewStore.openWindow = self.openWindow
                                self.webViewStore.dismissWindow = self.dismissWindow
                                #if os(iOS)
                                // Cache the scene while the view is in the hierarchy.
                                // removeWebView may race ahead of webView.window being set.
                                if let scene = self.webViewStore.getOrCreate(id).window?.windowScene {
                                    self.webViewStore.cacheScene(scene, for: id)
                                }
                                #endif
                            } else {
                                self.webViewStore.addWebView(self.webViewStore.getOrCreate(id))
                            }
                        }
                        .onDisappear{
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                                self.webViewStore.removeWebView(id)
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
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true, block: { [weak self] _ in
            guard let self = self else { return }
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
    var dismissWindow: DismissWindowAction?
    
    var webViews: [WebView] = []
    @Published var webViewsPublished: [WebView] = []
    // title, bgColor
    @Published var webViewsMeta: [UUID:(String, Color)] = [:]
    // IDs that have been explicitly closed — getOrCreate must not resurrect them
    private var closedIDs: Set<UUID> = []
    #if os(iOS)
    // Scene cache: populated in onAppear (view guaranteed in hierarchy) so
    // removeWebView can close the scene even if called before webView.window is set.
    private var cachedScenes: [UUID: UIWindowScene] = [:]
    func cacheScene(_ scene: UIWindowScene, for id: UUID) { cachedScenes[id] = scene }
    func getScene(for id: UUID) -> UIWindowScene? {
        return self.webViews.first(where: { $0.id == id })?.window?.windowScene ?? self.cachedScenes[id]
    }
    #endif
    
    func addWebView(_ webView: WebView) {
        if !self.webViews.contains(where: { $0.id == webView.id }) {
            self.webViews.append(webView)
        }
        if let openWindow = self.openWindow {
            openWindow(id: "FullStacked", value: webView.id)
        } else {
            if !self.webViewsPublished.contains(where: { $0.id == webView.id }) {
                self.webViewsPublished.append(webView)
            }
        }
    }
    
    func getOrCreate(_ id: UUID) -> WebView {
        if let webView = self.webViews.first(where: { $0.id == id }) {
            return webView
        }
        
        // Don't resurrect a WebView that was intentionally closed.
        // SwiftUI re-renders the WindowGroup body after @Published changes, which
        // calls getOrCreate again for the same UUID — without this guard it would
        // silently create a fresh WebView(nil) and spawn a second app instance.
        if self.closedIDs.contains(id), let existing = self.webViews.first {
            return existing
        }
        
        let webView = WebView(nil)
        webView.id = id
        self.webViews.append(webView)
        return webView
    }
    
    func removeWebView(_ id: UUID){
        self.closedIDs.insert(id)
        
        let webViewToRemove = self.webViews.first(where: { $0.id == id }) ?? self.webViewsPublished.first(where: { $0.id == id })
        
        self.webViewsPublished.removeAll(where: { $0.id == id })
        self.webViews.removeAll(where: { $0.id == id })
        self.webViewsMeta.removeValue(forKey: id)
        
        #if os(iOS)
        // Use the cached scene (stored in onAppear) as fallback when webView.window
        // is nil — this happens when exit runs before the view is fully in the hierarchy.
        // Destroy only when other WebViews exist; if this is the last one, iOS would
        // immediately auto-spawn a replacement, so fall back to dismissWindow instead.
        let scene = webViewToRemove?.window?.windowScene ?? self.cachedScenes[id]
        if let scene = scene, !self.webViews.isEmpty {
            UIApplication.shared.requestSceneSessionDestruction(scene.session, options: nil)
        } else if let dismissWindow = self.dismissWindow {
            dismissWindow(value: id)
        }
        self.cachedScenes.removeValue(forKey: id)
        #else
        if let dismissWindow = self.dismissWindow {
            dismissWindow(value: id)
        }
        #endif
        
        webViewToRemove?.close()
        
        if self.webViewsPublished.isEmpty && self.openWindow == nil && self.webViews.isEmpty {
            self.addWebView(WebView(nil))
        }
    }
    
    func safe(){
        var webViewsToClose: [WebView] = []
        for wv in self.webViews {
            if !webViewsToClose.contains(where: { $0.id == wv.id }) {
                webViewsToClose.append(wv)
            }
        }
        for wv in self.webViewsPublished {
            if !webViewsToClose.contains(where: { $0.id == wv.id }) {
                webViewsToClose.append(wv)
            }
        }
        
        let oldIDs = Set(webViewsToClose.map { $0.id })
        self.closedIDs.formUnion(oldIDs)
        
        self.webViews.removeAll()
        self.webViewsPublished.removeAll()
        self.webViewsMeta.removeAll()
        
        #if os(iOS)
        for id in oldIDs {
            if let scene = self.cachedScenes[id] {
                UIApplication.shared.requestSceneSessionDestruction(scene.session, options: nil)
            }
        }
        self.cachedScenes.removeAll()
        #endif
        
        for webView in webViewsToClose {
            #if !os(iOS)
            self.dismissWindow?(value: webView.id)
            #endif
            webView.close()
        }
        
        let safeCtx = startMain(0, true)
        let safeWebView = WebView(safeCtx)
        self.addWebView(safeWebView)
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
