import SwiftUI
import WebKit

// iOS

class ClipboardHelper: NSObject, WKScriptMessageHandler {
    var cb: ((_ requestClipboardID: String, _ clipboardContent: String) -> Void)?
    
    func setCallback(_ callback: @escaping (_ requestClipboardID: String, _ clipboardContent: String) -> Void) {
        self.cb = callback
    }
    
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let callback = self.cb {
            let requestClipboardID = message.body as! String;
            let clipboardContent = UIPasteboard.general.string ?? "";
            callback(requestClipboardID, clipboardContent)
        }
    }
}

class WebViewExtended: WKWebView  {
    let clipboardHelper: ClipboardHelper;
    
    override var safeAreaInsets: UIEdgeInsets {
        return UIEdgeInsets(top: super.safeAreaInsets.top, left: 0, bottom: 0, right: 0)
    }
    
    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        self.clipboardHelper = ClipboardHelper()
        
        super.init(frame: frame, configuration: configuration)
        
        configuration.userContentController.add(self.clipboardHelper, name: "clipboard")
        
        self.clipboardHelper.setCallback { (requestClipboardID, clipboardContent) in
            let b64 = Data(clipboardContent.utf8).base64EncodedString()
            self.evaluateJavaScript("window.respondClipboard(\"\(requestClipboardID)\", \"\(b64)\")")
        }
    }
    
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
    
    func close(){
        self.configuration.userContentController.removeScriptMessageHandler(forName: "clipboard")
    }
    
    func openBrowserURL(_ url: URL){
        if( UIApplication.shared.canOpenURL(url)) {
            UIApplication.shared.open(url)
        }
    }
    
    func openDownloadDirectory(){
        UIApplication.shared.open(URL(string: "shareddocuments://" + downloadDirectory)!)
    }
}

struct WebViewRepresentable: UIViewRepresentable {
    static let isIPadOS = UIDevice.current.userInterfaceIdiom == .pad
    
    private let webView: WebView
    init(_ webView: WebView) {
        self.webView = webView
    }
    
    func makeUIView(context: Context) -> WebView  {
        return self.webView
    }
    
    func updateUIView(_ uiView: WebView, context: Context) {
        
    }
}

func isFullScreen(size: CGSize) -> Bool {
    let screenHeight = UIScreen.main.bounds.size.height
        - 20 // navigation bar
        - 32 // status bar
    let screenWidth = UIScreen.main.bounds.size.width
    
    return screenHeight == size.height && screenWidth == size.width
}

extension Color {
    /// The hexadecimal integer representation of the Color (RGB).
    func hex() -> Int {
        // Convert SwiftUI Color to UIColor to get components.
        // The color must be resolved with the current environment for accurate values.
        let uiColor = UIColor(self)
        
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        
        // Get the color components. Returns false if the color space is not compatible.
        uiColor.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        
        // Convert normalized (0.0 to 1.0) components to 0-255 range integers
        let r = Int(red * 255.0)
        let g = Int(green * 255.0)
        let b = Int(blue * 255.0)
        
        // Combine components into a single UInt32 using bitwise shifts
        let hexInt = (r << 16) | (g << 8) | b
        
        return hexInt
    }
}
