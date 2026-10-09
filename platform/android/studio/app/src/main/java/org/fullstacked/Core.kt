package org.fullstacked

object Core {
    init {
        try {
            System.loadLibrary("core")
        } catch (_: Exception) { }
        System.loadLibrary("fullstacked-android")
        // the WebView does not expose request bodies: calls go on messages
        setPlatform("android", false)
        try {
            setOnStreamData()
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    @JvmStatic
    external fun setOnStreamData()

    @JvmStatic
    external fun start(root: String, build: String): Int

    @JvmStatic
    external fun startSafe(root: String, build: String): Int

    @JvmStatic
    external fun startWithCtx(root: String, build: String, ctxId: Int)

    @JvmStatic
    external fun check(ctxId: Int): Int

    @JvmStatic
    external fun stop(ctxId: Int)

    @JvmStatic
    external fun call(payload: ByteArray): Int

    @JvmStatic
    external fun getCorePayload(ctx: Int, coreType: Int, id: Int, size: Int): ByteArray

    @JvmStatic
    external fun callWithResponse(payload: ByteArray): ByteArray

    // a call received on a message channel: null when the core put a large
    // response on the frame stream
    @JvmStatic
    external fun callMessage(payload: ByteArray): ByteArray?

    @JvmStatic
    external fun setPlatform(name: String, binaryCalls: Boolean)

    // [status u16][mime type]\n[body]
    @JvmStatic
    external fun handleRequest(ctxId: Int, path: String): ByteArray

    class Response(val status: Int, val mimeType: String, val data: ByteArray)

    // a request of the page answered by the core (static files, /platform, /ctx...)
    fun request(ctxId: Int, path: String): Response {
        val response = handleRequest(ctxId, path)
        val status = ((response[0].toInt() and 0xFF) shl 8) or (response[1].toInt() and 0xFF)
        var newline = 2
        while (newline < response.size && response[newline] != 10.toByte()) newline++
        val mimeType = String(response, 2, newline - 2, Charsets.UTF_8)
        val data = if (newline < response.size) response.copyOfRange(newline + 1, response.size) else ByteArray(0)
        return Response(status, mimeType, data)
    }

    // stream data of a context as binary frames for GET /stream, see core/internal/frames
    @JvmStatic
    external fun streamAttach(ctxId: Int): Int

    // blocks until frames are queued, null once the reader ended
    @JvmStatic
    external fun streamRead(ctxId: Int, gen: Int): ByteArray?

    @JvmStatic
    external fun streamDetach(ctxId: Int, gen: Int)

    fun startMain(root: String, build: String, providedCtx: Int? = null, safe: Boolean = false): Int {
        return if (safe) {
            startSafe(root, build)
        } else if (providedCtx == null) {
            start(root, build)
        } else {
            startWithCtx(root, build, providedCtx)
            providedCtx
        }
    }

    // Calls Core Fn DeepLink in ctx: the deeplink plugins of ctx receive url.
    // Returns how many plugins were called.
    fun deepLink(ctx: Int, url: String): Int {
        val urlBytes = url.toByteArray(Charsets.UTF_8)
        var payload = byteArrayOf(
            ctx.toByte(),
            0, // req id, unused by callWithResponse
            0, // Core Module
            6, // Fn DeepLink
            0, // Async
            DataType.STRING.type
        )
        payload += numberToBytes(urlBytes.size)
        payload += urlBytes

        val response = coreCall(payload)
        if (response.size <= 1) return 0
        val count = deserializeArgs(sliceByteArray(response, 1, response.size - 1)).firstOrNull()
        return (count as? Number)?.toInt() ?: 0
    }

    // A deeplink comes from the outside: trigger it in every running context.
    fun deepLinkAll(url: String) {
        val contexts = MainActivity.activeActivities
            .flatMap { activity -> activity.stackedWebViews.map { it.ctxId.toInt() and 0xFF } }
            .toSet()
        for (ctx in contexts) {
            if (check(ctx) == 1) {
                deepLink(ctx, url)
            }
        }
    }

    // Thread safe: the core synchronizes per context, responses are returned
    // directly instead of being stored by request id, so concurrent calls
    // (static files, bridge) never collide.
    fun coreCall(payload: ByteArray): ByteArray = callWithResponse(payload)
}

fun coreCall(payload: ByteArray): ByteArray = Core.coreCall(payload)
