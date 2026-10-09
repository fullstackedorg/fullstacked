package org.fullstacked

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebResourceResponse
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

// The bridge between a page and the core (see core/internal/bundle/lib/bridge
// and perfs/porting.md). The page reaches it as `fullstackedCore`:
// - sync calls: coreCall(base64) returns the response in base64
// - small async calls: callAsync(base64) returns at once, large ones are posted
//   to the `fullstackedBridge` web message listener as an ArrayBuffer, both are
//   answered [id][response] through the listener ([id] alone when the core put
//   a large response on the frame stream)
// - GET /stream: the stream data as binary frames, every other request of the
//   page is answered by the core
class Bridge(private val ctxId: Int, private val webView: () -> WebView) {
    private val mainHandler = Handler(Looper.getMainLooper())
    // async calls of the page, in order, off the UI thread
    private val coreExecutor = Executors.newSingleThreadExecutor()
    // replies to the async calls, kept from the page's "init" message
    @Volatile private var replyProxy: JavaScriptReplyProxy? = null

    fun attach(view: WebView) {
        view.addJavascriptInterface(this, "fullstackedCore")
        // the page needs the listener (WebView 98+), it fails at init without
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
            WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
        ) {
            WebViewCompat.addWebMessageListener(view, "fullstackedBridge", setOf("http://localhost")) { _, message, _, isMainFrame, proxy ->
                if (isMainFrame) onMessage(message, proxy)
            }
        }
    }

    fun destroy() {
        coreExecutor.shutdown()
    }

    private fun onMessage(message: WebMessageCompat, proxy: JavaScriptReplyProxy) {
        if (message.type == WebMessageCompat.TYPE_STRING && message.data == "init") {
            replyProxy = proxy
            proxy.postMessage("ready")
        } else if (message.type == WebMessageCompat.TYPE_ARRAY_BUFFER) {
            callAsync(message.arrayBuffer, proxy)
        }
    }

    @JavascriptInterface
    fun callAsync(payloadBase64: String) {
        val proxy = replyProxy ?: return
        callAsync(Base64.getDecoder().decode(payloadBase64), proxy)
    }

    private fun callAsync(payload: ByteArray, proxy: JavaScriptReplyProxy) {
        if (payload.size < 5) return
        val id = payload[1]
        coreExecutor.execute {
            val response = Core.callMessage(payload)
            val reply = ByteArray((response?.size ?: 0) + 1)
            reply[0] = id
            response?.copyInto(reply, 1)
            mainHandler.post { proxy.postMessage(reply) }
        }
    }

    // sync calls of workers read their response with GET /sync/{id}
    private val syncAwaiters = ConcurrentHashMap<Int, (String) -> Unit>()
    private val syncResponses = ConcurrentHashMap<Int, String>()

    // Sync calls (the page waits) and the sync calls of workers relayed by the
    // page, which read their response with GET /sync/{id}
    @JavascriptInterface
    fun coreCall(payloadBase64: String): String {
        val payload = Base64.getDecoder().decode(payloadBase64)
        val response = Base64.getEncoder().encodeToString(Core.coreCall(payload))
        val id = payload[1].toInt() and 0xFF
        val awaiter = syncAwaiters.remove(id)
        if (awaiter != null) awaiter(response) else syncResponses[id] = response
        return response
    }

    private fun syncResponse(id: Int): WebResourceResponse {
        val output = PipedOutputStream()
        val input = PipedInputStream(output)
        val send: (String) -> Unit = { response ->
            try {
                output.write(response.toByteArray())
                output.close()
            } catch (_: Exception) { }
        }
        syncResponses.remove(id)?.let(send) ?: run { syncAwaiters[id] = send }
        return WebResourceResponse("text/plain", "UTF-8", input)
    }

    // stream chunks when the page reads no frames, evaluated once per main looper
    // iteration, a statement that throws does not stop the others of the batch
    private val streamLock = Any()
    private val pendingStreamScript = StringBuilder()
    private var streamFlushScheduled = false

    fun onStreamData(streamId: Int, buffer: ByteArray) {
        val b64 = Base64.getEncoder().encodeToString(buffer)
        val schedule = synchronized(streamLock) {
            pendingStreamScript.append("try{window.fullstacked.onStreamData($streamId, `$b64`)}catch(e){console.error(e)};")
            !streamFlushScheduled.also { streamFlushScheduled = true }
        }
        if (schedule) mainHandler.post {
            val script = synchronized(streamLock) {
                pendingStreamScript.toString().also {
                    pendingStreamScript.setLength(0)
                    streamFlushScheduled = false
                }
            }
            if (script.isNotEmpty()) webView().evaluateJavascript(script, null)
        }
    }

    fun request(path: String): WebResourceResponse {
        if (path == "/stream") return frameStream()
        path.removePrefix("/sync/").toIntOrNull()?.let { return syncResponse(it) }
        val response = Core.request(ctxId, path)
        // WebResourceResponse takes the charset of "text/html; charset=utf-8" apart
        val mimeType = response.mimeType.substringBefore(";").trim()
        val charset = response.mimeType.substringAfter("charset=", "").substringBefore(";").trim().ifEmpty { null }
        val headers = mapOf("Cache-Control" to "no-cache")
        return WebResourceResponse(mimeType, charset, response.status, if (response.status == 200) "OK" else "Not Found", headers, ByteArrayInputStream(response.data))
    }

    // GET /stream: the WebView reads the stream on its own thread. It takes the
    // response length from the first available() call (0 would make it empty),
    // then sizes each read from available() and reads until the buffer is full:
    // available() reports the largest length first, then blocks until frames are
    // queued and reports exactly their size so every read returns them as they come.
    private fun frameStream(): WebResourceResponse {
        val gen = Core.streamAttach(ctxId)
        if (gen < 0) return WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        val stream = object : InputStream() {
            private var frames: ByteArray? = null
            private var position = 0
            private var delivered = 0L
            private var lengthReported = false
            @Volatile private var ended = false

            // blocks until frames are available, false once the response ends
            private fun fill(): Boolean {
                while (frames.let { it == null || position >= it.size }) {
                    // the length is fixed, end the response between two batches of
                    // whole frames, still attached: the page reconnects and the core
                    // keeps the frames queued meanwhile
                    if (ended || delivered >= ROTATE_BYTES) {
                        ended = true
                        return false
                    }
                    frames = Core.streamRead(ctxId, gen) ?: run { ended = true; return false }
                    position = 0
                }
                return true
            }

            override fun available(): Int {
                if (!lengthReported) {
                    lengthReported = true
                    return Int.MAX_VALUE
                }
                return if (fill()) frames!!.size - position else 0
            }

            override fun read(): Int {
                val byte = ByteArray(1)
                return if (read(byte, 0, 1) <= 0) -1 else byte[0].toInt() and 0xFF
            }

            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (len == 0) return 0
                if (!fill()) return -1
                val n = minOf(len, frames!!.size - position)
                System.arraycopy(frames!!, position, b, off, n)
                position += n
                delivered += n
                return n
            }

            override fun close() {
                if (!ended) {
                    ended = true
                    Core.streamDetach(ctxId, gen)
                }
            }
        }
        // binary frames, never to be sniffed as another type
        val headers = mapOf("Cache-Control" to "no-cache", "X-Content-Type-Options" to "nosniff")
        return WebResourceResponse("application/x-fullstacked-frames", null, 200, "OK", headers, stream)
    }

    companion object {
        // under the length of a GET /stream response
        private const val ROTATE_BYTES = 1L shl 30
    }
}
