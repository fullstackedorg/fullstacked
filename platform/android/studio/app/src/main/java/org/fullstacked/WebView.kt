package org.fullstacked

import android.annotation.SuppressLint
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import android.webkit.WebView
import android.webkit.WebViewClient

class FullStackedWebView(
    val ctx: MainActivity,
    val ctxId: Byte = 0,
    val isSafe: Boolean = false
) : WebViewClient() {
    init {
        val c = ctxId.toInt() and 0xFF
        if (Core.check(c) == 0) {
            Core.startMain(ctx.getRootPath(), ctx.getMainLocation(), c, isSafe)
        }
    }

    val bridge = Bridge(ctxId.toInt() and 0xFF) { webView }

    val webView: WebView = createWebView(this)

    fun destroyView() {
        bridge.destroy()
        AuthManager.clearAuthSession(ctx, this)
        val c = ctxId.toInt() and 0xFF
        Core.stop(c)
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
    }

    override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
        val url = request?.url ?: return super.shouldOverrideUrlLoading(view, request)
        if (url.host == "localhost") {
            return super.shouldOverrideUrlLoading(view, request)
        }
        ctx.openUrl(this, url.toString())
        return true
    }

    override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
        val url = request?.url ?: return super.shouldInterceptRequest(view, request)
        if (url.host != "localhost") {
            return super.shouldInterceptRequest(view, request)
        }

        val path = url.path?.ifEmpty { "/" } ?: "/"
        // the UI endpoints of the page, the rest goes to the bridge
        when (path) {
            "/open" -> {
                url.getQueryParameter("ctx")?.toIntOrNull()?.let { ctx.openContextWindow(it) }
                return emptyResponse()
            }
            "/exit" -> {
                Handler(Looper.getMainLooper()).post { ctx.removeStackedProject(this) }
                return emptyResponse()
            }
        }
        return bridge.request(path)
    }

    private fun emptyResponse() =
        WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
}

@SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
fun createWebView(delegate: FullStackedWebView): WebView {
    WebView.setWebContentsDebuggingEnabled(true)
    val webView = WebView(delegate.ctx)

    webView.setBackgroundColor(Color.BLACK)
    webView.webViewClient = delegate
    webView.webChromeClient = object : WebChromeClient() {
        override fun onShowFileChooser(
            webView: WebView?,
            filePathCallback: ValueCallback<Array<Uri>>?,
            fileChooserParams: FileChooserParams?
        ): Boolean {
            try {
                delegate.ctx.fileChooserValueCallback = filePathCallback
                delegate.ctx.fileChooserResultLauncher.launch(fileChooserParams?.createIntent())
            } catch (_: Exception) { }
            return true
        }

        override fun onCreateWindow(
            view: WebView?,
            isDialog: Boolean,
            isUserGesture: Boolean,
            resultMsg: android.os.Message?
        ): Boolean {
            val transport = resultMsg?.obj as? WebView.WebViewTransport
            val tempWebView = WebView(delegate.ctx)
            tempWebView.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val url = request?.url?.toString()
                    if (url != null) {
                        delegate.ctx.openUrl(delegate, url)
                    }
                    tempWebView.destroy()
                    return true
                }
            }
            transport?.webView = tempWebView
            resultMsg?.sendToTarget()
            return true
        }
    }
    webView.isFocusable = true
    webView.isFocusableInTouchMode = true
    webView.settings.javaScriptEnabled = true
    webView.settings.javaScriptCanOpenWindowsAutomatically = true
    webView.settings.setSupportMultipleWindows(true)
    webView.settings.domStorageEnabled = true
    delegate.bridge.attach(webView)
    webView.loadUrl("http://localhost")

    return webView
}
