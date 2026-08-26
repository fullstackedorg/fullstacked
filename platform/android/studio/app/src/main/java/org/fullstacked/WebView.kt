package org.fullstacked

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.ContextCompat.startActivity
import java.io.ByteArrayInputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

class FullStackedWebView(
    val ctx: MainActivity,
    val ctxId: Byte = 0
) : WebViewClient() {
    val webView: WebView = createWebView(this)
    var firstContact = false
    val messageToBeSent = mutableListOf<Pair<String, String>>()

    private val syncAwaitersResolve = ConcurrentHashMap<Int, (String) -> Unit>()
    private val syncAwaitersPayload = ConcurrentHashMap<Int, String>()

    init {
        val c = ctxId.toInt() and 0xFF
        if (Core.check(c) == 0) {
            Core.startMain(ctx.getRootPath(), ctx.getMainLocation(), c)
        }
    }

    fun resolveSyncAwaiter(id: Int, payloadBase64: String) {
        val resolve = syncAwaitersResolve.remove(id)
        if (resolve != null) {
            resolve(payloadBase64)
        } else {
            syncAwaitersPayload[id] = payloadBase64
        }
    }

    @JavascriptInterface
    fun bridge(payloadBase64: String): String {
        return coreCall(payloadBase64)
    }

    @JavascriptInterface
    fun coreCall(payloadBase64: String): String {
        if (!this.firstContact) {
            this.firstContact = true
            this.messageToBeSent.forEach { this.onMessage(it.first, it.second) }
            this.messageToBeSent.clear()
        }

        val payload = Base64.getDecoder().decode(payloadBase64)
        val response = Core.coreCall(payload)

        val id = payload[1].toInt() and 0xFF
        val isSync = payload[4] == 1.toByte()
        val responseBase64 = Base64.getEncoder().encodeToString(response)

        if (isSync) {
            this.resolveSyncAwaiter(id, responseBase64)
            return responseBase64
        } else {
            val mainLooper = Looper.getMainLooper()
            val handler = Handler(mainLooper)
            handler.post {
                this.webView.evaluateJavascript("window.fullstacked.respond($id, `$responseBase64`)", null)
            }
            return ""
        }
    }

    @JavascriptInterface
    fun open(targetCtxId: Int) {
        val mainLooper = Looper.getMainLooper()
        val handler = Handler(mainLooper)
        handler.post {
            ctx.openContextWindow(targetCtxId)
        }
    }

    @JavascriptInterface
    fun openUrl(url: String) {
        val mainLooper = Looper.getMainLooper()
        val handler = Handler(mainLooper)
        handler.post {
            ctx.openUrl(this, url)
        }
    }

    @JavascriptInterface
    fun exit() {
        val mainLooper = Looper.getMainLooper()
        val handler = Handler(mainLooper)
        handler.post {
            ctx.removeStackedProject(this)
        }
    }

    fun onMessage(messageType: String, message: String) {
        if (!this.firstContact) {
            this.messageToBeSent.add(Pair(messageType, message))
            return
        }
        val mainLooper = Looper.getMainLooper()
        val handler = Handler(mainLooper)
        val messageEscaped = message
            .replace("\\", "\\\\")
            .replace("`", "\\`")
        handler.post {
            this.webView.evaluateJavascript("window.oncoremessage(`$messageType`, `$messageEscaped`)", null)
        }
    }

    fun onStreamData(streamId: Int, buffer: ByteArray) {
        val mainLooper = Looper.getMainLooper()
        val handler = Handler(mainLooper)
        val b64 = Base64.getEncoder().encodeToString(buffer)
        handler.post {
            this.webView.evaluateJavascript("window.fullstacked.onStreamData($streamId, `$b64`)", null)
        }
    }

    fun destroyView() {
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

        val path = url.path ?: ""

        if (path == "/platform") {
            return WebResourceResponse(
                "text/plain",
                "UTF-8",
                ByteArrayInputStream("android".toByteArray())
            )
        } else if (path == "/ctx") {
            val c = ctxId.toInt() and 0xFF
            return WebResourceResponse(
                "text/plain",
                "UTF-8",
                ByteArrayInputStream(c.toString().toByteArray())
            )
        } else if (path.startsWith("/sync/")) {
            val idStr = path.removePrefix("/sync/")
            val id = idStr.toIntOrNull()
            if (id != null) {
                val outputStream = PipedOutputStream()
                val inputStream = PipedInputStream(outputStream)

                val sendCallback: (String) -> Unit = { payload ->
                    try {
                        outputStream.write(payload.toByteArray(StandardCharsets.UTF_8))
                        outputStream.flush()
                        outputStream.close()
                    } catch (_: Exception) { }
                }

                val existingPayload = syncAwaitersPayload.remove(id)
                if (existingPayload != null) {
                    sendCallback(existingPayload)
                } else {
                    syncAwaitersResolve[id] = sendCallback
                }

                return WebResourceResponse(
                    "text/plain",
                    "UTF-8",
                    inputStream
                )
            }
        }

        // Static file serving via Core Fn StaticFile (Async payload)
        val pathnameBytes = path.toByteArray(StandardCharsets.UTF_8)
        var payload = byteArrayOf(
            ctxId,
            0, // req id
            0, // Core Module
            0, // Fn Static File
            0, // Async
            DataType.STRING.type // 2
        )
        payload += numberToBytes(pathnameBytes.size)
        payload += pathnameBytes

        val responseData = Core.coreCall(payload)

        if (responseData.size > 1) {
            val outerArgBuffer = sliceByteArray(responseData, 1, responseData.size - 1)
            val outerArgs = deserializeArgs(outerArgBuffer)

            val staticFileBuffer = if (outerArgs.isNotEmpty() && outerArgs[0] is ByteArray) {
                outerArgs[0] as ByteArray
            } else {
                outerArgBuffer
            }

            if (staticFileBuffer.isNotEmpty()) {
                val args = deserializeArgs(staticFileBuffer)

                if (args.size >= 2 && args[0] is String && args[1] is ByteArray) {
                    val rawMimeType = args[0] as String
                    val fileBytes = args[1] as ByteArray

                    val cleanMimeType = rawMimeType.substringBefore(";").trim()
                    val encoding = if (rawMimeType.contains("charset=", ignoreCase = true)) {
                        rawMimeType.substringAfter("charset=", "").substringBefore(";").trim().ifEmpty { "UTF-8" }
                    } else {
                        "UTF-8"
                    }

                    return WebResourceResponse(
                        cleanMimeType,
                        encoding,
                        ByteArrayInputStream(fileBytes)
                    )
                }
            }
        }

        return WebResourceResponse(
            "text/plain",
            "UTF-8",
            404,
            "Not Found",
            mapOf("Access-Control-Allow-Origin" to "*"),
            ByteArrayInputStream("Not Found".toByteArray())
        )
    }
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
    webView.settings.databaseEnabled = true
    webView.loadUrl("http://localhost")
    webView.addJavascriptInterface(delegate, "android")

    return webView
}
