import SwiftUI
@preconcurrency import WebKit

// MacOS

class ResizeHelper: NSObject, WKScriptMessageHandler {
    /// Weak reference to avoid a retain cycle with the owning WebViewExtended.
    weak var webView: WebViewExtended?
    private weak var observedWindow: NSWindow?

    var lastRequestedWidth: CGFloat?
    var lastRequestedHeight: CGFloat?
    var isFullScreen: Bool = false
    private var isChangingScreen: Bool = false

    func observeWindow(_ window: NSWindow) {
        if observedWindow === window { return }
        stopObservingWindow()
        observedWindow = window
        
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleScreenChange(_:)),
            name: NSWindow.didChangeScreenNotification,
            object: window
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleScreenChange(_:)),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleWindowResize(_:)),
            name: NSWindow.didResizeNotification,
            object: window
        )
    }

    func stopObservingWindow() {
        if let window = observedWindow {
            NotificationCenter.default.removeObserver(self, name: NSWindow.didChangeScreenNotification, object: window)
            NotificationCenter.default.removeObserver(self, name: NSApplication.didChangeScreenParametersNotification, object: nil)
            NotificationCenter.default.removeObserver(self, name: NSWindow.didResizeNotification, object: window)
            observedWindow = nil
        }
    }

    deinit {
        stopObservingWindow()
    }

    @objc func handleWindowResize(_ notification: Notification) {
        if isChangingScreen { return }
        guard let activeWindow = observedWindow ?? self.webView?.window else { return }
        if !isFullScreen && !activeWindow.styleMask.contains(.fullScreen) {
            lastRequestedWidth = activeWindow.frame.width
            lastRequestedHeight = activeWindow.frame.height
        }
    }

    @objc func handleScreenChange(_ notification: Notification) {
        guard let activeWindow = self.webView?.window ?? self.observedWindow else { return }
        let currentScreen = activeWindow.screen ?? findScreen(for: activeWindow.frame, defaultScreen: NSScreen.main)
        guard let visibleFrame = currentScreen?.visibleFrame ?? currentScreen?.frame else { return }
        
        if isFullScreen {
            if activeWindow.frame != visibleFrame {
                activeWindow.setFrame(visibleFrame, display: true)
            }
            return
        }
        
        let currentFrame = activeWindow.frame
        let targetW = lastRequestedWidth ?? currentFrame.width
        let targetH = lastRequestedHeight ?? currentFrame.height
        
        let frame = fitFrame(targetWidth: targetW, targetHeight: targetH, targetX: currentFrame.origin.x, targetY: currentFrame.origin.y, in: visibleFrame)
        if activeWindow.frame != frame {
            isChangingScreen = true
            activeWindow.setFrame(frame, display: true)
            isChangingScreen = false
        }
    }

    func findScreen(for rect: NSRect, defaultScreen: NSScreen?) -> NSScreen? {
        let screens = NSScreen.screens
        let originPoint = NSPoint(x: rect.origin.x, y: rect.origin.y)
        
        // 1. Check if any connected display contains the target origin point
        if let screen = screens.first(where: { NSPointInRect(originPoint, $0.frame) }) {
            return screen
        }
        
        // 2. Check if any connected display intersects the target frame (pick highest overlap area)
        var bestScreen: NSScreen? = nil
        var maxArea: CGFloat = 0
        for screen in screens {
            let intersection = rect.intersection(screen.frame)
            if !intersection.isNull && intersection.width * intersection.height > maxArea {
                maxArea = intersection.width * intersection.height
                bestScreen = screen
            }
        }
        if let bestScreen = bestScreen {
            return bestScreen
        }
        
        // 3. Target display is unavailable (e.g. disconnected monitor), fallback to default screen
        return defaultScreen ?? NSScreen.main ?? screens.first
    }

    func fitFrame(targetWidth: CGFloat, targetHeight: CGFloat, targetX: CGFloat, targetY: CGFloat, in visibleFrame: NSRect) -> NSRect {
        // 1. Aim as much as possible for target width/height, capped at screen bounds (never higher than screen width/height)
        let width = min(targetWidth, visibleFrame.width)
        let height = min(targetHeight, visibleFrame.height)

        // 2. Adjust X and Y: shift towards minX/minY if needed to fit window on screen, but NEVER less than visibleFrame.minX
        let maxX = max(visibleFrame.minX, visibleFrame.maxX - width)
        let maxY = max(visibleFrame.minY, visibleFrame.maxY - height)

        let x = max(visibleFrame.minX, min(targetX, maxX))
        let y = max(visibleFrame.minY, min(targetY, maxY))

        return NSRect(x: x, y: y, width: width, height: height)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body as! String
        
        if let activeWindow = self.webView?.window {
            observeWindow(activeWindow)
            let currentScreen = activeWindow.screen ?? findScreen(for: activeWindow.frame, defaultScreen: NSScreen.main)
            let visibleFrame = currentScreen?.visibleFrame ?? currentScreen?.frame ?? NSRect.zero
            
            if body == "get" {
                var responseStr = ""
                let frame = activeWindow.frame
                if activeWindow.styleMask.contains(.fullScreen) {
                    responseStr = "kiosk"
                } else if frame.size.width == visibleFrame.size.width &&
                            frame.size.height == visibleFrame.size.height &&
                            frame.origin.x == visibleFrame.origin.x &&
                            frame.origin.y == visibleFrame.origin.y {
                    responseStr = "fullscreen"
                } else {
                    responseStr = "\(frame.size.width):\(frame.size.height):\(frame.origin.x):\(frame.origin.y)"
                }
                self.webView?.evaluateJavaScript("window.fullstacked.window.respondGetSize(\"\(responseStr)\")")
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
                isFullScreen = true
                lastRequestedWidth = nil
                lastRequestedHeight = nil
                activeWindow.setFrame(visibleFrame, display: true)
                return
            }
            
            let components = body.split(separator: ":")
            if components.count == 2 {
                let width = Double(components[0])!
                let height = Double(components[1])!
                let currentFrame = activeWindow.frame
                let newWidth = CGFloat(width)
                let newHeight = CGFloat(height)
                
                isFullScreen = false
                lastRequestedWidth = newWidth
                lastRequestedHeight = newHeight
                
                let targetX = currentFrame.origin.x + (currentFrame.size.width - newWidth) / 2.0
                let targetY = currentFrame.origin.y + (currentFrame.size.height - newHeight) / 2.0
                
                let frame = fitFrame(targetWidth: newWidth, targetHeight: newHeight, targetX: targetX, targetY: targetY, in: visibleFrame)
                activeWindow.setFrame(frame, display: true)
            } else if components.count == 4 {
                let width = Double(components[0])!
                let height = Double(components[1])!
                let x = Double(components[2])!
                let y = Double(components[3])!
                
                let newWidth = CGFloat(width)
                let newHeight = CGFloat(height)
                
                isFullScreen = false
                lastRequestedWidth = newWidth
                lastRequestedHeight = newHeight
                
                let targetRect = NSRect(x: CGFloat(x), y: CGFloat(y), width: newWidth, height: newHeight)
                let targetScreen = findScreen(for: targetRect, defaultScreen: activeWindow.screen)
                let targetVisibleFrame = targetScreen?.visibleFrame ?? targetScreen?.frame ?? visibleFrame
                
                let frame = fitFrame(targetWidth: newWidth, targetHeight: newHeight, targetX: CGFloat(x), targetY: CGFloat(y), in: targetVisibleFrame)
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
        
        configuration.userContentController.add(WeakMessageHandler(self.resizeHelper), name: "resize")
        
        self.resizeHelper.webView = self
        
        self.uiDelegate = self
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let window = self.window {
            self.resizeHelper.observeWindow(window)
        } else {
            self.resizeHelper.stopObservingWindow()
        }
    }
    
    func openBrowserURL(_ url: URL){
        NSWorkspace.shared.open(url)
    }
    
    func openDownloadDirectory(){
        NSWorkspace.shared.open(URL(fileURLWithPath: downloadDirectory))
    }
    
    func close() {
        self.resizeHelper.stopObservingWindow()
        self.resizeHelper.webView = nil
        self.configuration.userContentController.removeScriptMessageHandler(forName: "resize")
        self.window?.close()
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
