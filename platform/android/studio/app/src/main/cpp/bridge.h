#include <jni.h>

#ifndef FULLSTACKED_ANDROID_BRIDGE_H
#define FULLSTACKED_ANDROID_BRIDGE_H

extern "C" {
    uint8_t start(char* root, char* build);
    void startWithCtx(char* root, char* build, uint8_t ctxId);
    int check(uint8_t ctxId);
    void stop(uint8_t ctxId);
    int call(void* buffer, int length);
    void getCorePayload(uint8_t ctx, uint8_t coreType, uint8_t id, void* ptr, int size);
    void setOnStreamData(void* cb);

    JNIEXPORT jint JNICALL Java_org_fullstacked_Core_start
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
    JNIEXPORT void JNICALL Java_org_fullstacked_Core_setOnStreamData
            (JNIEnv *, jobject);
}

#endif //FULLSTACKED_ANDROID_BRIDGE_H
