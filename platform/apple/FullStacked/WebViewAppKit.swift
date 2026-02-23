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
    
    func getBackgroundColor() -> Color {
        return Color(self.underPageBackgroundColor.cgColor)
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

extension Color {
    /// Converts the NSColor to a hexadecimal string representation (RRGGBB or RRGGBBAA).
    func hex() -> Int {
        let nsColor = NSColor(self)
                
        // Get the RGBA components
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        nsColor.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
                
        // Convert the components to 0-255 range Ints
        let r = Int(red * 255.0)
        let g = Int(green * 255.0)
        let b = Int(blue * 255.0)
        
        // Combine into a single UInt64 (RGB format, ignoring alpha for a 6-digit hex)
        let hexValue = (r << 16) | (g << 8) | b
        
        return hexValue
    }
}
