package org.fullstacked

object Core {
    init {
        try {
            System.loadLibrary("core")
        } catch (_: Exception) { }
        System.loadLibrary("fullstacked-android")
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
            0, // req id
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

    fun coreCall(payload: ByteArray): ByteArray {
        val responseSize = call(payload)
        if (responseSize <= 0) return ByteArray(0)
        val ctx = payload[0].toInt() and 0xFF
        val id = payload[1].toInt() and 0xFF
        return getCorePayload(ctx, 1, id, responseSize)
    }
}

fun coreCall(payload: ByteArray): ByteArray = Core.coreCall(payload)
