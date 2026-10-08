package org.fullstacked

import android.annotation.SuppressLint
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
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

class FullStackedWebView(
    val ctx: MainActivity,
    val ctxId: Byte = 0,
    val isSafe: Boolean = false
) : WebViewClient() {
    var firstContact = false
    val messageToBeSent = mutableListOf<Pair<String, String>>()

    private val syncAwaitersResolve = ConcurrentHashMap<Int, (String) -> Unit>()
    private val syncAwaitersPayload = ConcurrentHashMap<Int, String>()

    // stream chunks received between two main looper iterations are evaluated in one script
    private val mainHandler = Handler(Looper.getMainLooper())
    private val streamLock = Any()
    private val pendingStreamScript = StringBuilder()
    private var streamFlushScheduled = false

    init {
        val c = ctxId.toInt() and 0xFF
        if (Core.check(c) == 0) {
            Core.startMain(ctx.getRootPath(), ctx.getMainLocation(), c, isSafe)
        }
    }

    val webView: WebView = createWebView(this)

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
        val b64 = Base64.getEncoder().encodeToString(buffer)
        // a statement that throws does not stop the others of the batch
        val script = "try{window.fullstacked.onStreamData($streamId, `$b64`)}catch(e){console.error(e)};"
        val schedule = synchronized(streamLock) {
            pendingStreamScript.append(script)
            val schedule = !streamFlushScheduled
            streamFlushScheduled = true
            schedule
        }
        if (schedule) {
            mainHandler.post { flushStreamData() }
        }
    }

    private fun flushStreamData() {
        val script = synchronized(streamLock) {
            val script = pendingStreamScript.toString()
            pendingStreamScript.setLength(0)
            streamFlushScheduled = false
            script
        }
        if (script.isNotEmpty()) {
            this.webView.evaluateJavascript(script, null)
        }
    }

    fun destroyView() {
        AuthManager.clearAuthSession(ctx, this)
        val c = ctxId.toInt() and 0xFF
        Core.stop(c)
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
    }

    // Stream data of the context as binary frames (see core/internal/frames), the
    // WebView reads the stream on its own thread and hands the data to the page
    // as it comes, until the context ends or the page goes away.
    private fun frameStreamResponse(): WebResourceResponse {
        val c = ctxId.toInt() and 0xFF
        val gen = Core.streamAttach(c)
        if (gen < 0) {
            return WebResourceResponse(
                "text/plain",
                "UTF-8",
                404,
                "Not Found",
                emptyMap(),
                ByteArrayInputStream("Not Found".toByteArray())
            )
        }

        val stream = object : InputStream() {
            private var frames: ByteArray? = null
            private var position = 0
            @Volatile private var ended = false

            override fun read(): Int {
                val byte = ByteArray(1)
                return if (read(byte, 0, 1) <= 0) -1 else byte[0].toInt() and 0xFF
            }

            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (len == 0) return 0
                while (true) {
                    val current = frames
                    if (current != null && position < current.size) {
                        val n = minOf(len, current.size - position)
                        System.arraycopy(current, position, b, off, n)
                        position += n
                        return n
                    }
                    if (ended) return -1
                    val next = Core.streamRead(c, gen)
                    if (next == null) {
                        ended = true
                        return -1
                    }
                    frames = next
                    position = 0
                }
            }

            override fun available(): Int {
                val current = frames ?: return 0
                return current.size - position
            }

            override fun close() {
                if (!ended) {
                    ended = true
                    Core.streamDetach(c, gen)
                }
            }
        }

        return WebResourceResponse(
            "application/octet-stream",
            null,
            200,
            "OK",
            mapOf("Cache-Control" to "no-cache"),
            stream
        )
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
        } else if (path == "/stream") {
            return frameStreamResponse()
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
            0, // req id, unused by callWithResponse
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
    webView.addJavascriptInterface(delegate, "android")
    webView.loadUrl("http://localhost")

    return webView
}
