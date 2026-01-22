import SwiftUI
import WebKit

// iOS

class WebViewExtended: WKWebView {
    override var safeAreaInsets: UIEdgeInsets {
        return UIEdgeInsets(top: super.safeAreaInsets.top, left: 0, bottom: 0, right: 0)
    }
    
    func openBrowserURL(_ url: URL){
        if( UIApplication.shared.canOpenURL(url)) {
            UIApplication.shared.open(url)
        }
    }
    
    func openDownloadDirectory(){
        UIApplication.shared.open(URL(string: "shareddocuments://" + downloadDirectory)!)
    }
    
    // source: https://stackoverflow.com/a/28528496
//    func snapshotImageToWindowColor(projectId: String, image: UIImage){
//        let imageRef = image.cgImage
//        
//        let pixelData = imageRef?.dataProvider?.data
//        let pixelDataPtr = CFDataGetBytePtr(pixelData)!
//        let r = pixelDataPtr[0]
//        let g = pixelDataPtr[1]
//        let b = pixelDataPtr[2]
//        
//        let colorInt = (Int(r) << 16) | (Int(g) << 8) | Int(b);
//        FullStackedApp.singleton?.webViews.setColor(projectId: projectId, color: colorInt)
//    }
}

struct WebViewRepresentable: UIViewRepresentable {
    static let isIPadOS = UIDevice.current.userInterfaceIdiom == .pad
    
    private let webView: WebView;
    init(webView: WebView) {
        self.webView = webView
    }
    
    func makeUIView(context: Context) -> WebView  {
        return webView
    }
    
    func updateUIView(_ uiView: WebView, context: Context) {
        
    }
}
