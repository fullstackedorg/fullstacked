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
            if let bodyDict = message.body as? [String: Any] {
                if let action = bodyDict["action"] as? String {
                    if action == "copy", let text = bodyDict["text"] as? String {
                        UIPasteboard.general.string = text
                    } else if action == "paste", let requestClipboardID = bodyDict["id"] as? String {
                        let clipboardContent = UIPasteboard.general.string ?? ""
                        callback(requestClipboardID, clipboardContent)
                    }
                }
            } else if let requestClipboardID = message.body as? String {
                let clipboardContent = UIPasteboard.general.string ?? ""
                callback(requestClipboardID, clipboardContent)
            }
        }
    }
}

class WebViewExtended: WKWebView, WKUIDelegate  {
    let clipboardHelper: ClipboardHelper;
    
    override var safeAreaInsets: UIEdgeInsets {
        return .zero
    }
    
    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        self.clipboardHelper = ClipboardHelper()
        
        super.init(frame: frame, configuration: configuration)
        
        self.scrollView.contentInsetAdjustmentBehavior = .never
        self.scrollView.automaticallyAdjustsScrollIndicatorInsets = false
        self.scrollView.contentInset = .zero
        self.scrollView.scrollIndicatorInsets = .zero
        self.scrollView.alwaysBounceVertical = false
        self.scrollView.alwaysBounceHorizontal = false
        
        // WeakMessageHandler proxy prevents WKUserContentController from strongly retaining clipboardHelper.
        configuration.userContentController.add(WeakMessageHandler(self.clipboardHelper), name: "clipboard")
        
        self.clipboardHelper.setCallback { [weak self] (requestClipboardID, clipboardContent) in
            guard let self = self else { return }
            let b64 = Data(clipboardContent.utf8).base64EncodedString()
            self.evaluateJavaScript("window.fullstacked.clipboard.respondPaste(\(requestClipboardID), \"\(b64)\")")
        }
        
        self.uiDelegate = self
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
        uiView.scrollView.contentInsetAdjustmentBehavior = .never
        uiView.scrollView.contentInset = .zero
        uiView.scrollView.scrollIndicatorInsets = .zero
    }
}

/// Tracks the software keyboard visibility and height.
final class KeyboardObserver {
    static let shared = KeyboardObserver()
    
    private(set) var isKeyboardVisible: Bool = false
    private(set) var keyboardHeight: CGFloat = 0
    
    private init() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardWillShow(_:)),
            name: UIResponder.keyboardWillShowNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardDidShow(_:)),
            name: UIResponder.keyboardDidShowNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardWillHide(_:)),
            name: UIResponder.keyboardWillHideNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardDidHide(_:)),
            name: UIResponder.keyboardDidHideNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(keyboardDidChangeFrame(_:)),
            name: UIResponder.keyboardDidChangeFrameNotification,
            object: nil
        )
    }
    
    @objc private func keyboardWillShow(_ notification: Notification) {
        if let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect {
            self.keyboardHeight = frame.height
            self.isKeyboardVisible = frame.height > 0
        }
    }
    
    @objc private func keyboardDidShow(_ notification: Notification) {
        if let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect {
            self.keyboardHeight = frame.height
            self.isKeyboardVisible = frame.height > 0
        }
    }
    
    @objc private func keyboardWillHide(_ notification: Notification) {
        self.keyboardHeight = 0
        self.isKeyboardVisible = false
    }
    
    @objc private func keyboardDidHide(_ notification: Notification) {
        self.keyboardHeight = 0
        self.isKeyboardVisible = false
    }
    
    @objc private func keyboardDidChangeFrame(_ notification: Notification) {
        if let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect {
            let screenHeight = UIScreen.main.bounds.height
            if frame.origin.y >= screenHeight || frame.height <= 0 {
                self.keyboardHeight = 0
                self.isKeyboardVisible = false
            } else {
                self.keyboardHeight = frame.height
                self.isKeyboardVisible = true
            }
        }
    }
}

/// Retrieves the status bar height programmatically from the active or given window scene.
func getStatusBarHeight(windowScene: UIWindowScene? = nil) -> CGFloat {
    let scene = windowScene ?? (UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first(where: { $0.activationState == .foregroundActive })
        ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    
    if let height = scene?.statusBarManager?.statusBarFrame.height, height > 0 {
        return height
    }
    
    if let window = scene?.windows.first(where: { $0.isKeyWindow }) ?? scene?.windows.first {
        if window.safeAreaInsets.top > 0 {
            return window.safeAreaInsets.top
        }
    }
    
    return 0
}

/// Retrieves the navigation bar height programmatically by inspecting the view hierarchy or falling back to UINavigationController.
func getNavigationBarHeight(window: UIWindow? = nil, windowScene: UIWindowScene? = nil) -> CGFloat {
    let targetWindow: UIWindow? = window ?? {
        let scene = windowScene ?? (UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive })
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        return scene?.windows.first(where: { $0.isKeyWindow }) ?? scene?.windows.first
    }()
    
    if let targetWindow = targetWindow,
       let navBar = findNavigationBar(in: targetWindow) {
        let height = navBar.frame.height
        if height > 0 {
            return height
        }
    }
    
    let defaultNavBar = UINavigationController().navigationBar
    let frameHeight = defaultNavBar.frame.height
    if frameHeight > 0 {
        return frameHeight
    }
    
    let fitHeight = defaultNavBar.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: .greatestFiniteMagnitude)).height
    if fitHeight > 0 {
        return fitHeight
    }
    
    return 44.0
}

private func findNavigationBar(in view: UIView) -> UINavigationBar? {
    if let navBar = view as? UINavigationBar {
        return navBar
    }
    for subview in view.subviews {
        if let navBar = findNavigationBar(in: subview) {
            return navBar
        }
    }
    return nil
}

/// Retrieves the screen size programmatically from the active or given window scene.
func getScreenSize(windowScene: UIWindowScene? = nil) -> CGSize {
    let scene = windowScene ?? (UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first(where: { $0.activationState == .foregroundActive })
        ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    
    if let screen = scene?.screen {
        return screen.bounds.size
    }
    
    return UIScreen.main.bounds.size
}

/// Calculates the exact available space on the display for the webview.
func getAvailableDisplaySize(
    windowScene: UIWindowScene? = nil,
    isFullScreen fullScreenOverride: Bool? = nil
) -> CGSize {
    let scene = windowScene ?? (UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first(where: { $0.activationState == .foregroundActive })
        ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    
    let screen = getScreenSize(windowScene: scene)
    let targetWindow = scene?.windows.first(where: { $0.isKeyWindow }) ?? scene?.windows.first
    let windowSize = targetWindow?.bounds.size ?? screen
    
    let fullScreen = fullScreenOverride ?? isFullScreen(size: windowSize, windowScene: scene)
    
    if fullScreen {
        return screen
    } else {
        let navHeight = getNavigationBarHeight(window: targetWindow, windowScene: scene)
        return CGSize(width: windowSize.width, height: max(0, windowSize.height - navHeight))
    }
}

/// Determines whether the window is currently in full-screen mode on iPadOS, even when the software keyboard is open.
func isFullScreen(
    size: CGSize,
    windowScene: UIWindowScene? = nil,
    navigationBarHeight: CGFloat? = nil,
    statusBarHeight: CGFloat? = nil,
    screenSize: CGSize? = nil
) -> Bool {
    guard size.width > 0 && size.height > 0 else {
        return false
    }
    
    let scene = windowScene ?? (UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .first(where: { $0.activationState == .foregroundActive })
        ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
    
    let screen = screenSize ?? getScreenSize(windowScene: scene)
    let targetWindow = scene?.windows.first(where: { $0.isKeyWindow }) ?? scene?.windows.first
    
    // 1. Check window / scene bounds directly (these do not shrink when keyboard opens)
    if let window = targetWindow {
        let windowSize = window.bounds.size
        if abs(windowSize.width - screen.width) < 1.0 && abs(windowSize.height - screen.height) < 1.0 {
            return true
        }
    }
    if let scene = scene {
        let sceneSize = scene.coordinateSpace.bounds.size
        if abs(sceneSize.width - screen.width) < 1.0 && abs(sceneSize.height - screen.height) < 1.0 {
            return true
        }
    }
    
    // 2. On iPad, a window is full-screen horizontally if and only if it spans the full screen width.
    let isFullWidth = abs(screen.width - size.width) < 1.0
    guard isFullWidth else {
        return false
    }
    
    // 3. If keyboard is visible and the view spans full width, it is in full screen mode with keyboard open
    if KeyboardObserver.shared.isKeyboardVisible {
        return true
    }
    
    let navHeight = navigationBarHeight ?? getNavigationBarHeight(window: targetWindow, windowScene: scene)
    let statusHeight = statusBarHeight ?? getStatusBarHeight(windowScene: scene)
    let bottomInset = targetWindow?.safeAreaInsets.bottom ?? 0
    
    var expectedHeights: [CGFloat] = [
        screen.height - navHeight - statusHeight,
        screen.height - statusHeight,
        screen.height - navHeight - statusHeight - bottomInset,
        screen.height - statusHeight - bottomInset,
        screen.height - bottomInset,
        screen.height
    ]
    
    let keyboardHeight = KeyboardObserver.shared.keyboardHeight
    if keyboardHeight > 0 {
        expectedHeights += expectedHeights.map { $0 - keyboardHeight }
    }
    
    if expectedHeights.contains(where: { abs($0 - size.height) < 2.0 }) {
        return true
    }
    
    // If the window spans the full screen width and height is reasonable (reduced by keyboard or safe areas)
    if size.height <= screen.height && size.height >= (screen.height * 0.25) {
        return true
    }
    
    return false
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
