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

    fun getConfig(ctx: Int, key: String): String? {
        val keyData = key.toByteArray(Charsets.UTF_8)
        val keyLen = keyData.size
        val payload = ByteArray(5 + 1 + 4 + keyLen)
        payload[0] = (ctx and 0xFF).toByte()
        payload[1] = 0 // id
        payload[2] = 16 // Config Module
        payload[3] = 0 // Get
        payload[4] = 1 // Sync
        payload[5] = 2 // STRING type
        payload[6] = ((keyLen shr 24) and 0xFF).toByte()
        payload[7] = ((keyLen shr 16) and 0xFF).toByte()
        payload[8] = ((keyLen shr 8) and 0xFF).toByte()
        payload[9] = (keyLen and 0xFF).toByte()
        System.arraycopy(keyData, 0, payload, 10, keyLen)

        val response = coreCall(payload)
        if (response.size > 6 && response[0].toInt() == 1 && response[1].toInt() == 2) {
            val strLen = ((response[2].toInt() and 0xFF) shl 24) or
                         ((response[3].toInt() and 0xFF) shl 16) or
                         ((response[4].toInt() and 0xFF) shl 8) or
                         (response[5].toInt() and 0xFF)
            if (response.size >= 6 + strLen) {
                val str = String(response, 6, strLen, Charsets.UTF_8).trim()
                if (str.isNotEmpty()) return str
            }
        }

        return null
    }

    fun startMain(root: String, build: String, providedCtx: Int? = null, skipInitialDir: Boolean = false): Int {
        val mainCtx = if (providedCtx == null) {
            start(root, build)
        } else {
            startWithCtx(root, build, providedCtx)
            providedCtx
        }

        if (providedCtx != null || skipInitialDir) {
            return mainCtx
        }

        val initialDir = getConfig(mainCtx, "initialDirectory")
        if (initialDir != null && initialDir.trim().isNotEmpty()) {
            stop(mainCtx)

            val trimmed = initialDir.trim()
            val subPath = if (trimmed.startsWith("/")) trimmed.substring(1) else trimmed
            val launchRoot = java.io.File(root, subPath).absolutePath
            return start(launchRoot, launchRoot)
        }

        return mainCtx
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
