import SwiftUI
import WebKit

extension Color {
    init(hex: Int, opacity: Double = 1.0) {
        let red = Double((hex & 0xff0000) >> 16) / 255.0
        let green = Double((hex & 0xff00) >> 8) / 255.0
        let blue = Double((hex & 0xff) >> 0) / 255.0
        self.init(.sRGB, red: red, green: green, blue: blue, opacity: opacity)
    }
}

func setDirectories(){
    let paths = NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true);
    let root = (isMacOS || isSimulator) ? paths.first! : ("/private" + paths.first!)
    let config = root + "/.config"
    let editor = Bundle.main.path(forResource: "build", ofType: nil)!
    let tmp = root + "/.tmp"

    directories(
        root.ptr(),
        config.ptr(),
        editor.ptr(),
        tmp.ptr()
    )
}

func CallbackC(
    projectIdPtr: UnsafeMutablePointer<Int8>,
    messageTypePtr: UnsafeMutablePointer<Int8>,
    msgPtr: UnsafeMutablePointer<Int8>,
    msgLength: Int
) {
    let projectId = String(cString: projectIdPtr)
    let messageType = String(cString: messageTypePtr)
    let messageData = Data(bytes: msgPtr, count: msgLength)
    let message = String(data: messageData, encoding: .utf8) ?? ""
    
    if(projectId == "*") {
        FullStackedApp.singleton?.webViews.getEditor().onMessage(messageType: messageType, message: message)
        
        FullStackedApp.singleton?.webViews.viewsStacked.forEach({$0.onMessage(messageType: messageType, message: message)})
        
        FullStackedApp.singleton?.webViews.viewsWindowed.forEach({$0.onMessage(messageType: messageType, message: message)})
        
    } else if(projectId == "") {
        
        if(messageType == "open") {
            FullStackedApp.singleton?.webViews.addWebView(projectId: message)
        } else if(FullStackedApp.singleton!.webViews.ready) {
            FullStackedApp.singleton?.webViews.getEditor().onMessage(messageType: messageType, message: message)
        }
        
    } else if let webview = FullStackedApp.singleton?.webViews.getView(projectId: projectId) {
        if(messageType == "title"){
            FullStackedApp.singleton?.webViews.titles[projectId] = message
        } else {
            webview.onMessage(messageType: messageType, message: message)
        }
    }
}

func setCallback(){
    let cb: @convention(c) (UnsafeMutablePointer<Int8>,
                            UnsafeMutablePointer<Int8>,
                            UnsafeMutablePointer<Int8>,
                            Int
    ) -> Void = CallbackC
    let cbPtr = unsafeBitCast(cb, to: UnsafeMutableRawPointer.self)
    callback(cbPtr)
}


class WebViews: ObservableObject {
    @Published var viewsStacked: [WebView] = []
    var viewsWindowed: [WebView] = []
    @Published var titles: [String:String] = [:]
    @Published var colors: [String:Int] = [:]
    var ready = false
    private var editor: WebView?
    
    func getEditor() -> WebView {
        if(self.editor == nil) {
            self.editor = WebView(instance: Instance(projectId: "", isEditor: true))
        }
        return self.editor!
    }
    
    func addWebView(projectId: String, inWindow: Bool = false) {
        if let existingView = self.getView(projectId: projectId) {
            existingView.reload()
            
            // if the view exists (in windowed), but we are on iPadOS, dont trigger another openWindow.. it hides other windows. Bug?
            // 2025-06-27
            if isIPadOS {
                return
            }
        }
        
        let webView = WebView(instance: Instance(projectId: projectId))
        if(inWindow) {
            self.viewsWindowed.append(webView)
        } else {
            self.viewsStacked.append(webView)
        }
    }
    
    private func getViewWindowed(projectId: String?) -> WebView? {
        return self.viewsWindowed.first(where: {$0.requestHandler.instance.id == projectId})
    }
    
    func getView(projectId: String?, windowCreate: Bool = false) -> WebView? {
        if(projectId == nil) {
            return nil
        } else if let view = self.viewsStacked.first(where: {$0.requestHandler.instance.id == projectId}) {
            return view
        } else if let view = self.getViewWindowed(projectId: projectId) {
            return view
        } else if(windowCreate && !self.getEditor().firstContact) {
            self.addWebView(projectId: projectId!, inWindow: true)
            return self.getView(projectId: projectId)
        }
        
        return nil
    }
    
    func removeView(projectId: String?) {
        var view: WebView? = nil
        
        if let viewIndex = self.viewsStacked.firstIndex(where: { $0.requestHandler.instance.id == projectId }) {
            view = self.viewsStacked.remove(at: viewIndex)
        } else if let viewIndex = self.viewsWindowed.firstIndex(where: { $0.requestHandler.instance.id == projectId }) {
            view = self.viewsWindowed.remove(at: viewIndex)
        }
        
        if let removedView = view {
            removedView.close()
            colors.removeValue(forKey: removedView.requestHandler.instance.id)
            titles.removeValue(forKey: removedView.requestHandler.instance.id)
        }
    }
    
    func getColor(projectId: String?) -> Int {
        if let id = projectId {
            let c = colors[id]
            return c ?? EditorColor
        }
        return EditorColor
    }
    
    func getTitle(projectId: String?) -> String {
        if let id = projectId {
            return titles[id] ?? id
        }
        return "FullStacked"
    }
 
    func setColor(projectId: String, color: Int) {
        colors[projectId] = color
    }
    
    func setWindowed(projectId: String) {
        if let viewIndex = self.viewsStacked.firstIndex(where: {$0.requestHandler.instance.id == projectId}) {
            let view = self.viewsStacked.remove(at: viewIndex)
            
            let viewWindowed = self.viewsWindowed.first(where: {$0.requestHandler.instance.id == projectId})
            if(viewWindowed == nil) {
                self.viewsWindowed.append(view)
            } else {
                view.close()
            }
        }
    }
}



struct WebViewInWindow: View {
    @Environment(\.dismiss) private var dismiss
    
    let projectId: String?
    let webView: WebView?
    
    init(projectId: String?) {
        self.projectId = projectId
        self.webView = FullStackedApp.singleton?.webViews.getView(projectId: projectId, windowCreate: true)
    }
    
    var body: some View {
        HStack {
            if(webView != nil) {
                WebViewRepresentable(webView: webView!)
                    .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
                    .edgesIgnoringSafeArea(.all)
                    .ignoresSafeArea()
            }
        }
        .onDisappear {
            FullStackedApp.singleton?.webViews.removeView(projectId: projectId)
        }
        
    }
}

struct WebViewEditor: View {
    var webView: WebView;
    
    var body: some View {
        WebViewRepresentable(webView: self.webView)
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
            .edgesIgnoringSafeArea(.all)
            .ignoresSafeArea()
            .onOpenURL{ url in
                self.webView.onMessage(messageType: "deeplink", message: url.absoluteString)
            }
    }
}

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


@available(iOS 16.0, *)
struct WebViewsStacked: View {
    @ObservedObject var webViews: WebViews;
    
    @Environment(\.supportsMultipleWindows) public var supportsMultipleWindows
    @Environment(\.openWindow) private var openWindow

    init(webViews: WebViews) {
        self.webViews = webViews
    }
    
    var body: some View {
        ZStack {
            WebViewEditor(webView: self.webViews.getEditor())
                .onAppear{
                    self.webViews.ready = true
                }
            ForEach(self.webViews.viewsStacked.indices, id: \.self) { webViewIndex in
                VStack(spacing: 0) {
                    HStack(alignment: .center) {
                        Button {
                            let projectId = self.webViews.viewsStacked[webViewIndex].requestHandler.instance.id
                            self.webViews.removeView(projectId: projectId)
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .keyboardShortcut("w", modifiers: .command)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(EdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10))
                    }
                    
                    WebViewRepresentable(webView: self.webViews.viewsStacked[webViewIndex])
                        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
                        .edgesIgnoringSafeArea(.all)
                        .ignoresSafeArea()
                        .onAppear() {
                            if(isMacOS || self.supportsMultipleWindows) {
                                let projectId = self.webViews.viewsStacked[webViewIndex].requestHandler.instance.id
                                self.webViews.setWindowed(projectId: projectId)
                                self.openWindow(id: "window-webview", value: projectId)
                            }
                        }
                }
                .background(Color(hex: FullStackedApp.singleton!.webViews.getColor(projectId: self.webViews.viewsStacked[webViewIndex].requestHandler.instance.id)))
            }
        }
        .background(Color(hex: EditorColor))
    }
}

struct WebViewsStackedLegacy: View {
    @ObservedObject var webViews: WebViews;
    
    init(webViews: WebViews) {
        self.webViews = webViews
    }
    
    var body: some View {
        ZStack {
            WebViewEditor(webView: self.webViews.getEditor())
                .onAppear{
                    self.webViews.ready = true
                }
            ForEach(self.webViews.viewsStacked.indices, id: \.self) { webViewIndex in
                VStack(spacing: 0) {
                    HStack(alignment: .center) {
                        Button {
                            let projectId = self.webViews.viewsStacked[webViewIndex].requestHandler.instance.id
                            self.webViews.removeView(projectId: projectId)
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .keyboardShortcut("w", modifiers: .command)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(EdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10))
                    }
                    
                    WebViewRepresentable(webView: self.webViews.viewsStacked[webViewIndex])
                        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
                        .edgesIgnoringSafeArea(.all)
                        .ignoresSafeArea()
                }
                .background(Color(hex: FullStackedApp.singleton!.webViews.getColor(projectId: self.webViews.viewsStacked[webViewIndex].requestHandler.instance.id)))
            }
        }
        .background(Color(hex: EditorColor))
    }
}

extension String {
    func ptr() -> UnsafeMutablePointer<Int8> {
        return UnsafeMutablePointer<Int8>(mutating: (self as NSString).utf8String!)
    }
}
