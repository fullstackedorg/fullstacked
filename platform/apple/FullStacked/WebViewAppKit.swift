import SwiftUI
@preconcurrency import WebKit

// MacOS

class ResizeHelper: NSObject, WKScriptMessageHandler {
    var webView: WebViewExtended?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body as! String
        
        if let activeWindow = self.webView?.window {
            let screenFrame = activeWindow.screen?.frame ?? NSScreen.main?.frame ?? NSRect.zero
            
            if body == "get" {
                var responseStr = ""
                let frame = activeWindow.frame
                if activeWindow.styleMask.contains(.fullScreen) {
                    responseStr = "kiosk"
                } else if frame.size.width == screenFrame.size.width &&
                            frame.size.height == screenFrame.size.height &&
                            frame.origin.x == 0 &&
                            frame.origin.y == 0 {
                    responseStr = "fullscreen"
                } else {
                    responseStr = "\(frame.size.width):\(frame.size.height):\(frame.origin.x):\(frame.origin.y)"
                }
                self.webView?.evaluateJavaScript("window.respondResize(\"\(responseStr)\")")
                return
            }
            
            if body == "kiosk" {
                if !activeWindow.styleMask.contains(.fullScreen) {
                    activeWindow.toggleFullScreen(nil)
                }
                return
            }
            
            if activeWindow.styleMask.contains(.fullScreen) {
                activeWindow.toggleFullScreen(nil)
            }
            
            if body == "fullscreen" {
                let frame = NSRect(x: 0, y: 0, width: screenFrame.size.width, height: screenFrame.size.height)
                activeWindow.setFrame(frame, display: true)
                return
            }
            
            let components = body.split(separator: ":")
            if components.count == 2 {
                let width = Double(components[0])!
                let height = Double(components[1])!
                let currentFrame = activeWindow.frame
                let newWidth = CGFloat(width)
                let newHeight = CGFloat(height)
                
                let newX = currentFrame.origin.x + (currentFrame.size.width - newWidth) / 2.0
                let newY = currentFrame.origin.y + (currentFrame.size.height - newHeight) / 2.0
                
                let frame = NSRect(x: newX, y: newY, width: newWidth, height: newHeight)
                activeWindow.setFrame(frame, display: true)
            } else if components.count == 4 {
                let width = Double(components[0])!
                let height = Double(components[1])!
                let x = Double(components[2])!
                let y = Double(components[3])!
                
                let frame = NSRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(width), height: CGFloat(height))
                activeWindow.setFrame(frame, display: true)
            }
        }
    }
}

class WebViewExtended: WKWebView, WKUIDelegate {
    let resizeHelper: ResizeHelper
    
    override init(frame: CGRect, configuration: WKWebViewConfiguration){
        self.resizeHelper = ResizeHelper()
        
        super.init(frame: frame, configuration: configuration)
        
        configuration.userContentController.add(self.resizeHelper, name: "resize")
        
        self.resizeHelper.webView = self
        
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
    
    func close() {
        self.resizeHelper.webView = nil
        self.configuration.userContentController.removeScriptMessageHandler(forName: "resize")
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
        view.addSubview(self.webView);
        return view
    }
    
    
    func updateNSView(_ uiView: NSView, context: Context) {    }
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
