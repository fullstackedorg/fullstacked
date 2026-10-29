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
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue

// The bridge between a page and the core (see core/internal/bundle/lib/bridge
// and improvements/perfs/porting.md). The page reaches it as `fullstackedCore`:
// - sync calls: coreCall(base64) returns the response in base64
// - async calls come batched, [length u32 BE][payload]... : small batches as
//   callAsync(base64), large ones posted to the `fullstackedBridge` web message
//   listener as an ArrayBuffer. They run in order on one thread and the replies
//   of the calls processed while the queue was non-empty go back in one
//   message, [id u8][length u32 BE][response]... through the listener, a
//   length of 0 when the core put the response on the frame stream
// - GET /stream: the stream data as binary frames, every other request of the
//   page is answered by the core
class Bridge(private val ctxId: Int, private val webView: () -> WebView) {
    private val mainHandler = Handler(Looper.getMainLooper())
    // skips the sync barriers of the main looper (frame rendering)
    private val asyncMainHandler = Handler.createAsync(Looper.getMainLooper())
    // replies to the async calls, kept from the page's "init" message
    @Volatile private var replyProxy: JavaScriptReplyProxy? = null

    // where the replies are posted from: "mainAsync" (the async main handler,
    // measured fastest: the proxy posts cheapest from the main thread and the
    // async handler skips the barriers of frame rendering), "main", or
    // "worker" (the call thread); the page can switch it with setOption
    @Volatile private var replyThread = "mainAsync"
    // a reply batch is flushed when the call queue is empty or past this size
    @Volatile private var replyBatchMax = 256 * 1024

    // the async calls of the page, in order, off the UI thread
    private val calls = LinkedBlockingQueue<ByteArray>()
    @Volatile private var running = true
    private val worker = Thread({ callLoop() }, "FullStacked calls").apply {
        isDaemon = true
        start()
    }

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
        running = false
        worker.interrupt()
    }

    private fun onMessage(message: WebMessageCompat, proxy: JavaScriptReplyProxy) {
        if (message.type == WebMessageCompat.TYPE_STRING && message.data == "init") {
            replyProxy = proxy
            proxy.postMessage("ready")
        } else if (message.type == WebMessageCompat.TYPE_ARRAY_BUFFER) {
            enqueueBatch(message.arrayBuffer)
        }
    }

    @JavascriptInterface
    fun callAsync(batchBase64: String) {
        enqueueBatch(Base64.getDecoder().decode(batchBase64))
    }

    @JavascriptInterface
    fun setOption(name: String, value: String) {
        when (name) {
            "replyThread" -> replyThread = value
            "replyBatchMax" -> value.toIntOrNull()?.let { replyBatchMax = it }
        }
    }

    // [length u32 BE][payload]...
    private fun enqueueBatch(batch: ByteArray) {
        var offset = 0
        while (offset + 4 <= batch.size) {
            val length = ((batch[offset].toInt() and 0xFF) shl 24) or
                ((batch[offset + 1].toInt() and 0xFF) shl 16) or
                ((batch[offset + 2].toInt() and 0xFF) shl 8) or
                (batch[offset + 3].toInt() and 0xFF)
            offset += 4
            if (length < 5 || offset + length > batch.size) return
            calls.add(batch.copyOfRange(offset, offset + length))
            offset += length
        }
    }

    private fun callLoop() {
        val replies = ByteArrayOutputStream()
        while (running) {
            var payload = try { calls.take() } catch (_: InterruptedException) { return }
            while (true) {
                appendReply(replies, payload)
                if (replies.size() >= replyBatchMax) flushReplies(replies)
                payload = calls.poll() ?: break
            }
            flushReplies(replies)
        }
    }

    // [id u8][length u32 BE][response], length 0 when the core framed it
    private fun appendReply(replies: ByteArrayOutputStream, payload: ByteArray) {
        val response = try { Core.callMessage(payload) } catch (_: Exception) { null }
        val length = response?.size ?: 0
        replies.write(payload[1].toInt())
        replies.write(length ushr 24)
        replies.write(length ushr 16)
        replies.write(length ushr 8)
        replies.write(length)
        if (response != null) replies.write(response)
    }

    private fun flushReplies(replies: ByteArrayOutputStream) {
        if (replies.size() == 0) return
        val proxy = replyProxy ?: run { replies.reset(); return }
        val bytes = replies.toByteArray()
        replies.reset()
        when (replyThread) {
            "main" -> mainHandler.post { proxy.postMessage(bytes) }
            "mainAsync" -> asyncMainHandler.post { proxy.postMessage(bytes) }
            else -> try {
                proxy.postMessage(bytes)
            } catch (_: Exception) {
                mainHandler.post { proxy.postMessage(bytes) }
            }
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
