package org.fullstacked.editor

class Instance(val projectId: String, val isEditor: Boolean = false) {
    private var headerRequest: ByteArray

    private external fun call(buffer: ByteArray): ByteArray

    init {
        if(this.isEditor) {
            this.headerRequest = byteArrayOf(
                1 // isEditor
            )
            this.headerRequest += numberToBytes(0) // no project id
        } else {
            this.headerRequest = byteArrayOf(
                0 // is not Editor
            )
            val idData = this.projectId.toByteArray()
            this.headerRequest += numberToBytes(idData.size)
            this.headerRequest += idData
        }
    }

    fun callLib(payload: ByteArray) : ByteArray {
        return this.call(this.headerRequest + payload)
    }
}