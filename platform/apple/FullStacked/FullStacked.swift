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
func getBestSuitedColorScheme(c: Int) -> ColorScheme {
    let r = ((c >> 16) & 0xff)
    let g = ((c >>  8) & 0xff)
    let b = ((c      ) & 0xff)
    let o = ((r * 299) + (g * 587) + (b * 114)) / 1000
    return o >= 180 ? .light : .dark
}


@main
struct FullStackedApp: App {
    var webViews: [WebView] = []
    
    init() {
        webViews.append(WebView(directory: Bundle.main.path(forResource: "build", ofType: nil)!))
    }
    
    var body: some Scene {
        WindowGroup("FullStacked"){
            ZStack{
                ForEach(webViews, id: \.self) { webView in //
                    WebViewRepresentable(webView: webView)
                }
            }
        }
    }
}
