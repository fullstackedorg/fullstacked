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
            let webView = self.webViewStore.getOrCreate(id)
            
            #if os(iOS)
            let isFull = isFullScreen(size: self.windowSize, windowScene: self.webViewStore.getScene(for: webView.id))
            #else
            let isFull = true
            #endif
            
            (self.webViewStore.webViewsMeta[webView.id]?.1 ?? Color(hex: 0))
                .ignoresSafeArea()
                .navigationTitle(self.webViewStore.webViewsMeta[webView.id]?.0 ?? "FullStacked")
            
                .onGeometryChange(for: CGSize.self) { proxy in
                    proxy.size
                } action: { newSize in
                    self.windowSize = newSize
                }
            
                .overlay {
                    NavigationStack {
                        ZStack {
                            (self.webViewStore.webViewsMeta[webView.id]?.1 ?? Color(hex: 0))
                                .ignoresSafeArea()
                            
                            if self.supportsMultipleWindows {
                                WebViewRepresentable(webView)
                                    .id(webView.id)
                                    #if os(iOS)
                                    .ignoresSafeArea(edges: .bottom)
                                    #else
                                    .ignoresSafeArea()
                                    #endif
                                    .background(self.webViewStore.webViewsMeta[webView.id]?.1)
                                    .navigationTitle(self.webViewStore.webViewsMeta[webView.id]?.0 ?? "FullStacked")
                                
                                #if os(macOS)
                                    .preferredColorScheme(getBestSuitedColorScheme(color: self.webViewStore.webViewsMeta[webView.id]?.1))
                                    .padding(EdgeInsets(top: 1, leading: 0, bottom: 0, trailing: 0))
                                    .toolbar{
                                        Spacer()
                                    }
                                    .toolbarBackground(self.webViewStore.webViewsMeta[webView.id]?.1 ?? Color(red: 0, green: 0, blue: 0, opacity: 0))
                                #else
                                    .preferredColorScheme(isIPadOS
                                                          ? getBestSuitedColorScheme(color: self.webViewStore.webViewsMeta[webView.id]?.1)
                                                          : nil)
                                    .toolbar(
                                        isIPadOS && !isFull ? .visible : .hidden,
                                        for: .navigationBar)
                                    .toolbarBackground(self.webViewStore.webViewsMeta[webView.id]?.1 ?? Color(hex: 0), for: .navigationBar)
                                    .navigationBarTitleDisplayMode(.inline)
                                #endif
                            } else {
                                ForEach(self.webViewStore.webViewsPublished, id: \.id) { wv in
                                    VStack {
                                        if self.webViewStore.webViewsPublished.count > 1 {
                                            HStack(alignment: .center) {
                                                Button {
                                                    self.webViewStore.removeWebView(wv.id)
                                                } label: {
                                                    Image(systemName: "xmark")
                                                        .tint(getBestSuitedColorScheme(color: self.webViewStore.webViewsMeta[wv.id]?.1) == .dark
                                                              ? .white
                                                              : .black)
                                                }
                                                .frame(maxWidth: .infinity, alignment: .trailing)
                                                .padding(windowSize.width > windowSize.height
                                                         ? EdgeInsets(top: 10, leading: 0, bottom: 2, trailing: 10)
                                                         : EdgeInsets(top: 2, leading: 0, bottom: 2, trailing: 10))
                                            }
                                        }
                                        
                                        WebViewRepresentable(wv)
                                            .id(wv.id)
                                            #if os(iOS)
                                            .ignoresSafeArea(edges: .bottom)
                                            #else
                                            .ignoresSafeArea()
                                            #endif
                                    }
                                    .background(self.webViewStore.webViewsMeta[wv.id]?.1 ?? Color(.black))
                                    .preferredColorScheme(getBestSuitedColorScheme(color: self.webViewStore.webViewsMeta[wv.id]?.1))
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
                                if let scene = webView.window?.windowScene {
                                    self.webViewStore.cacheScene(scene, for: webView.id)
                                }
                                #endif
                            } else {
                                self.webViewStore.addWebView(webView)
                            }
                        }
                        .onDisappear{
                            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                                self.webViewStore.removeWebView(id)
                                self.webViewStore.cleanupClosed(id)
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
        .commands {
            CommandMenu("Developer") {
                Button("Safe Mode") {
                    WebViewStore.getInstance().safe()
                }
                .keyboardShortcut("t", modifiers: [.command, .shift])
            }
        }
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
    private var closedWebViews: [UUID: WebView] = [:]
    
    func cleanupClosed(_ id: UUID) {
        self.closedWebViews.removeValue(forKey: id)
    }
    #if os(iOS)
    // Scene cache: populated in didMoveToWindow and onAppear so
    // removeWebView can close the scene even if called before webView.window is set.
    private var cachedScenes: [UUID: UIWindowScene] = [:]
    func cacheScene(_ scene: UIWindowScene, for id: UUID) { cachedScenes[id] = scene }
    func getScene(for id: UUID) -> UIWindowScene? {
        let wv = self.webViews.first(where: { $0.id == id }) ?? self.webViewsPublished.first(where: { $0.id == id })
        return wv?.window?.windowScene ?? self.cachedScenes[id] ?? self.findScene(for: wv, id: id)
    }
    
    func findScene(for webView: WebView?, id: UUID) -> UIWindowScene? {
        if let scene = webView?.window?.windowScene {
            return scene
        }
        if let scene = self.cachedScenes[id] {
            return scene
        }
        for scene in UIApplication.shared.connectedScenes {
            guard let windowScene = scene as? UIWindowScene else { continue }
            if let wv = webView {
                for window in windowScene.windows {
                    if window === wv.window || isViewDescendant(view: window, target: wv) {
                        return windowScene
                    }
                }
            }
        }
        return nil
    }
    
    private func isViewDescendant(view: UIView, target: UIView) -> Bool {
        if view === target { return true }
        for subview in view.subviews {
            if isViewDescendant(view: subview, target: target) {
                return true
            }
        }
        return false
    }
    #endif
    
    func addWebView(_ webView: WebView) {
        if !self.webViews.contains(where: { $0.id == webView.id }) {
            self.webViews.append(webView)
        }
        if !self.webViewsPublished.contains(where: { $0.id == webView.id }) {
            self.webViewsPublished.append(webView)
        }
        if let openWindow = self.openWindow {
            openWindow(id: "FullStacked", value: webView.id)
        }
    }
    
    func getOrCreate(_ id: UUID) -> WebView {
        if let webView = self.webViews.first(where: { $0.id == id }) {
            return webView
        }
        
        // Don't resurrect a WebView that was intentionally closed.
        // Return existing closed instance or a dummy without starting a Go context.
        if self.closedIDs.contains(id) {
            if let closed = self.closedWebViews[id] {
                return closed
            }
            let deadWV = WebView(dummy: true)
            deadWV.id = id
            self.closedWebViews[id] = deadWV
            return deadWV
        }
        
        let webView = WebView(nil)
        webView.id = id
        self.webViews.append(webView)
        return webView
    }
    
    func removeWebView(_ id: UUID){
        if self.closedIDs.contains(id) {
            return
        }
        self.closedIDs.insert(id)
        
        let webViewToRemove = self.webViews.first(where: { $0.id == id }) ?? self.webViewsPublished.first(where: { $0.id == id })
        if let wv = webViewToRemove {
            self.closedWebViews[id] = wv
        }
        
        #if os(iOS)
        let scene = webViewToRemove?.window?.windowScene ?? self.cachedScenes[id] ?? self.findScene(for: webViewToRemove, id: id)
        #endif
        
        self.webViewsPublished.removeAll(where: { $0.id == id })
        self.webViews.removeAll(where: { $0.id == id })
        self.webViewsMeta.removeValue(forKey: id)
        
        #if os(iOS)
        if let scene = scene {
            let options = UIWindowSceneDestructionRequestOptions()
            options.windowDismissalAnimation = .standard
            UIApplication.shared.requestSceneSessionDestruction(scene.session, options: options, errorHandler: { error in
                print("[removeWebView] Error destroying scene session: \(error)")
            })
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
    
    func safe(from originatingWebView: WebView? = nil){
        // 1. Identify target WebView to keep and switch to safe mode
        let targetWebView: WebView? = {
            if let originating = originatingWebView, self.webViews.contains(where: { $0 === originating }) {
                return originating
            }
            #if os(iOS)
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            // First prefer scene containing keyWindow
            if let keyScene = scenes.first(where: { scene in scene.windows.contains(where: { $0.isKeyWindow }) }) {
                if let wv = self.webViews.first(where: { $0.window?.windowScene === keyScene }) {
                    return wv
                }
            }
            // Next prefer foregroundActive scene
            if let activeScene = scenes.first(where: { $0.activationState == .foregroundActive }) {
                if let wv = self.webViews.first(where: { $0.window?.windowScene === activeScene }) {
                    return wv
                }
            }
            #else
            if let wv = self.webViews.first(where: { $0.window?.isKeyWindow == true }) {
                return wv
            }
            #endif
            return self.webViews.first
        }()
        
        guard let target = targetWebView else {
            let safeWV = WebView(nil, safe: true)
            self.addWebView(safeWV)
            return
        }
        
        #if os(iOS)
        let targetScene = target.window?.windowScene ?? self.cachedScenes[target.id]
        #endif
        
        // 2. Identify all other webviews to dismiss and close
        var otherWebViews: [WebView] = []
        for wv in self.webViews where wv !== target {
            if !otherWebViews.contains(where: { $0.id == wv.id }) {
                otherWebViews.append(wv)
            }
        }
        for wv in self.webViewsPublished where wv !== target {
            if !otherWebViews.contains(where: { $0.id == wv.id }) {
                otherWebViews.append(wv)
            }
        }
        
        // 3. Dismiss secondary scenes and close other webviews
        for wv in otherWebViews {
            self.closedIDs.insert(wv.id)
            self.closedWebViews[wv.id] = wv
            
            #if os(iOS)
            let scene = wv.window?.windowScene ?? self.cachedScenes[wv.id] ?? self.findScene(for: wv, id: wv.id)
            if let scene = scene, scene !== targetScene {
                let options = UIWindowSceneDestructionRequestOptions()
                options.windowDismissalAnimation = .standard
                UIApplication.shared.requestSceneSessionDestruction(scene.session, options: options, errorHandler: { error in
                    print("[safe] Error destroying secondary scene: \(error)")
                })
            } else if let dismissWindow = self.dismissWindow {
                dismissWindow(value: wv.id)
            }
            #else
            self.dismissWindow?(value: wv.id)
            #endif
            
            wv.close()
            self.webViewsMeta.removeValue(forKey: wv.id)
        }
        
        #if os(iOS)
        if let targetScene = targetScene {
            self.cachedScenes = [target.id: targetScene]
        } else {
            self.cachedScenes.removeAll()
        }
        #endif
        
        // 4. Retain only target in store
        self.webViews = [target]
        self.webViewsPublished = [target]
        self.webViewsMeta[target.id] = ("FullStacked", target.getBackgroundColor())
        
        // 5. Smoothly switch target to safe mode
        target.switchToSafeMode()
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
