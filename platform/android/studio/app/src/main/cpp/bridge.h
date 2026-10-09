#include <jni.h>

#ifndef FULLSTACKED_ANDROID_BRIDGE_H
#define FULLSTACKED_ANDROID_BRIDGE_H

extern "C" {
    uint8_t start(char* root, char* build);
    uint8_t startSafe(char* root, char* build);
    void startWithCtx(char* root, char* build, uint8_t ctxId);
    int check(uint8_t ctxId);
    void stop(uint8_t ctxId);
    int call(void* buffer, int length);
    void* callWithResponse(void* buffer, int length, int* size);
    void* callMessage(void* buffer, int length, int* size);
    void setPlatform(char* name, int binaryCalls);
    void* handleRequest(uint8_t ctxId, char* path, void* body, int length, int* status, int* size);
    void freePtr(void* ptr);
    int streamAttach(uint8_t ctxId);
    void* streamRead(uint8_t ctxId, int gen, int* size);
    void streamDetach(uint8_t ctxId, int gen);
    void getCorePayload(uint8_t ctx, uint8_t coreType, uint8_t id, void* ptr, int size);
    void setOnStreamData(void* cb);

    JNIEXPORT jint JNICALL Java_org_fullstacked_Core_start
            (JNIEnv *, jobject, jstring, jstring);
    JNIEXPORT jint JNICALL Java_org_fullstacked_Core_startSafe
            (JNIEnv *, jobject, jstring, jstring);
    JNIEXPORT void JNICALL Java_org_fullstacked_Core_startWithCtx
            (JNIEnv *, jobject, jstring, jstring, jint);
    JNIEXPORT jint JNICALL Java_org_fullstacked_Core_check
            (JNIEnv *, jobject, jint);
    JNIEXPORT void JNICALL Java_org_fullstacked_Core_stop
            (JNIEnv *, jobject, jint);
    JNIEXPORT jint JNICALL Java_org_fullstacked_Core_call
            (JNIEnv *, jobject, jbyteArray);
    JNIEXPORT jbyteArray JNICALL Java_org_fullstacked_Core_getCorePayload
            (JNIEnv *, jobject, jint, jint, jint, jint);
    JNIEXPORT jbyteArray JNICALL Java_org_fullstacked_Core_callWithResponse
            (JNIEnv *, jobject, jbyteArray);
    JNIEXPORT jbyteArray JNICALL Java_org_fullstacked_Core_callMessage
            (JNIEnv *, jobject, jbyteArray);
    JNIEXPORT void JNICALL Java_org_fullstacked_Core_setPlatform
            (JNIEnv *, jobject, jstring, jboolean);
    JNIEXPORT jbyteArray JNICALL Java_org_fullstacked_Core_handleRequest
            (JNIEnv *, jobject, jint, jstring);
    JNIEXPORT jint JNICALL Java_org_fullstacked_Core_streamAttach
            (JNIEnv *, jobject, jint);
    JNIEXPORT jbyteArray JNICALL Java_org_fullstacked_Core_streamRead
            (JNIEnv *, jobject, jint, jint);
    JNIEXPORT void JNICALL Java_org_fullstacked_Core_streamDetach
            (JNIEnv *, jobject, jint, jint);
    JNIEXPORT void JNICALL Java_org_fullstacked_Core_setOnStreamData
            (JNIEnv *, jobject);
}

#endif //FULLSTACKED_ANDROID_BRIDGE_H
