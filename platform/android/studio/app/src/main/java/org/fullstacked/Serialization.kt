package org.fullstacked

import java.nio.charset.StandardCharsets

enum class DataType(val type: Byte) {
    UNDEFINED(0),
    BOOLEAN(1),
    STRING(2),
    NUMBER(3),
    BUFFER(4),
    OBJECT(5);

    companion object {
        fun from(value: Byte) = entries.firstOrNull { it.type == value } ?: UNDEFINED
    }
}

fun numberToBytes(num: Int): ByteArray {
    val bytes = ByteArray(4)
    bytes[0] = ((num.toUInt() and 0xff000000u) shr 24).toByte()
    bytes[1] = ((num.toUInt() and 0x00ff0000u) shr 16).toByte()
    bytes[2] = ((num.toUInt() and 0x0000ff00u) shr 8).toByte()
    bytes[3] = ((num.toUInt() and 0x000000ffu) shr 0).toByte()
    return bytes
}

fun bytesToNumber(bytes: ByteArray): Int {
    if (bytes.size < 4) return 0
    return ((bytes[0].toUByte().toInt() shl 24) or
            (bytes[1].toUByte().toInt() shl 16) or
            (bytes[2].toUByte().toInt() shl 8) or
            (bytes[3].toUByte().toInt() shl 0))
}

fun sliceByteArray(data: ByteArray, from: Int, length: Int): ByteArray {
    val buffer = ByteArray(length)
    for (i in 0 until length) {
        if (from + i < data.size) {
            buffer[i] = data[from + i]
        }
    }
    return buffer
}

fun serializeArgs(args: List<Any?>): ByteArray {
    var payload = ByteArray(0)
    for (arg in args) {
        when (arg) {
            null -> {
                payload += byteArrayOf(DataType.UNDEFINED.type)
                payload += numberToBytes(0)
            }
            is Boolean -> {
                payload += byteArrayOf(DataType.BOOLEAN.type)
                payload += numberToBytes(1)
                payload += byteArrayOf(if (arg) 1 else 0)
            }
            is String -> {
                val strBytes = arg.toByteArray(StandardCharsets.UTF_8)
                payload += byteArrayOf(DataType.STRING.type)
                payload += numberToBytes(strBytes.size)
                payload += strBytes
            }
            is Int -> {
                payload += byteArrayOf(DataType.NUMBER.type)
                payload += numberToBytes(4)
                payload += numberToBytes(arg)
            }
            is ByteArray -> {
                payload += byteArrayOf(DataType.BUFFER.type)
                payload += numberToBytes(arg.size)
                payload += arg
            }
            else -> {
                val strBytes = arg.toString().toByteArray(StandardCharsets.UTF_8)
                payload += byteArrayOf(DataType.OBJECT.type)
                payload += numberToBytes(strBytes.size)
                payload += strBytes
            }
        }
    }
    return payload
}

fun deserializeArgs(data: ByteArray): MutableList<Any?> {
    val args = mutableListOf<Any?>()
    var cursor = 0
    while (cursor < data.size) {
        val type = DataType.from(data[cursor])
        cursor += 1
        if (cursor + 4 > data.size) break

        val bufferLength = sliceByteArray(data, cursor, 4)
        val length = bytesToNumber(bufferLength)
        cursor += 4

        val arg = sliceByteArray(data, cursor, length)
        cursor += length

        when (type) {
            DataType.UNDEFINED -> args.add(null)
            DataType.BOOLEAN -> args.add(arg.isNotEmpty() && arg[0].toInt() == 1)
            DataType.STRING -> args.add(String(arg, StandardCharsets.UTF_8))
            DataType.NUMBER -> args.add(if (arg.size >= 4) bytesToNumber(arg) else null)
            DataType.BUFFER -> args.add(arg)
            DataType.OBJECT -> args.add(String(arg, StandardCharsets.UTF_8))
        }
    }
    return args
}
