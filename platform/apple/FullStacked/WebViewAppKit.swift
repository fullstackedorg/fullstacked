import SwiftUI
@preconcurrency import WebKit

// MacOS

class WebViewExtended: WKWebView, WKUIDelegate {
    override init(frame: CGRect, configuration: WKWebViewConfiguration){
        super.init(frame: frame, configuration: configuration)
        self.uiDelegate = self
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    func openBrowserURL(_ url: URL){
        NSWorkspace.shared.open(url)
    }
    
    func openDownloadDirectory(){
        NSWorkspace.shared.open(URL(fileURLWithPath: downloadDirectory))
    }
    
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let openPanel = NSOpenPanel()
        openPanel.canChooseFiles = true
        openPanel.allowsMultipleSelection = parameters.allowsMultipleSelection
        openPanel.begin { (result) in
            if result == NSApplication.ModalResponse.OK {
                completionHandler(openPanel.urls)
            } else if result == NSApplication.ModalResponse.cancel {
                completionHandler(nil)
            }
        }
    }
    
    func snapshotImageToWindowColor(projectId: String, image: NSImage){
//        var imageRect = CGRect(x: 0, y: 0, width: image.size.width, height: image.size.height)
//        let imageRef = image.cgImage(forProposedRect: &imageRect, context: nil, hints: nil)
//        
//        let bitmapRep = NSBitmapImageRep(cgImage: imageRef!)
//        let color = bitmapRep.colorAt(x: 0, y: 0)
//        let r = color!.redComponent * 255
//        let g = color!.greenComponent * 255
//        let b = color!.blueComponent * 255
//        
//        let colorInt = (Int(r) << 16) | (Int(g) << 8) | Int(b);
//        FullStackedApp.singleton?.webViews.setColor(projectId: projectId, color: colorInt)
    }
}

// suppress "funk" noise
// source: https://stackoverflow.com/a/69858444
class KeyView: NSView {
    override var acceptsFirstResponder: Bool { true }
    override func keyDown(with event: NSEvent) {}
}

struct WebViewRepresentable: NSViewRepresentable {
    private let webView: WebView;
    init(_ webView: WebView) {
        self.webView = webView
    }
    
    func makeNSView(context: Context) -> NSView  {
        let view = KeyView()
        DispatchQueue.main.async {
            view.window?.makeFirstResponder(view)
        }
        
        self.webView.autoresizingMask = [.width, .height]
        view.addSubview(webView);
        return view
    }
    
    
    func updateNSView(_ uiView: NSView, context: Context) { }
}
