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
    external fun startWithCtx(root: String, build: String, ctxId: Int)

    @JvmStatic
    external fun check(ctxId: Int): Int

    @JvmStatic
    external fun stop(ctxId: Int)

    @JvmStatic
    external fun call(payload: ByteArray): Int

    @JvmStatic
    external fun getCorePayload(ctx: Int, coreType: Int, id: Int, size: Int): ByteArray

    fun startMain(root: String, build: String, providedCtx: Int? = null): Int {
        return if (providedCtx == null) {
            start(root, build)
        } else {
            startWithCtx(root, build, providedCtx)
            providedCtx
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
