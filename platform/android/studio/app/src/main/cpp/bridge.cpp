#include <android/log.h>
#include "bridge.h"

#include <cstring>
#include <string>
#include <vector>
#include <functional>

extern "C" {

JNIEXPORT jint JNICALL Java_org_fullstacked_Core_start
        (JNIEnv *env, jobject thiz, jstring root, jstring build) {
    const char* rootPtr = env->GetStringUTFChars(root, nullptr);
    const char* buildPtr = env->GetStringUTFChars(build, nullptr);

    uint8_t ctxId = start(const_cast<char*>(rootPtr), const_cast<char*>(buildPtr));

    env->ReleaseStringUTFChars(root, rootPtr);
    env->ReleaseStringUTFChars(build, buildPtr);

    return static_cast<jint>(ctxId);
}

JNIEXPORT void JNICALL Java_org_fullstacked_Core_startWithCtx
        (JNIEnv *env, jobject thiz, jstring root, jstring build, jint ctxId) {
    const char* rootPtr = env->GetStringUTFChars(root, nullptr);
    const char* buildPtr = env->GetStringUTFChars(build, nullptr);

    startWithCtx(const_cast<char*>(rootPtr), const_cast<char*>(buildPtr), static_cast<uint8_t>(ctxId));

    env->ReleaseStringUTFChars(root, rootPtr);
    env->ReleaseStringUTFChars(build, buildPtr);
}

JNIEXPORT jint JNICALL Java_org_fullstacked_Core_check
        (JNIEnv *env, jobject thiz, jint ctxId) {
    return check(static_cast<uint8_t>(ctxId));
}

JNIEXPORT void JNICALL Java_org_fullstacked_Core_stop
        (JNIEnv *env, jobject thiz, jint ctxId) {
    stop(static_cast<uint8_t>(ctxId));
}

JNIEXPORT jint JNICALL Java_org_fullstacked_Core_call
        (JNIEnv *env, jobject thiz, jbyteArray payload) {
    int length = env->GetArrayLength(payload);
    jbyte* buffer = env->GetByteArrayElements(payload, nullptr);

    int responseSize = call(static_cast<void*>(buffer), length);

    env->ReleaseByteArrayElements(payload, buffer, JNI_ABORT);

    return responseSize;
}

JNIEXPORT jbyteArray JNICALL Java_org_fullstacked_Core_getCorePayload
        (JNIEnv *env, jobject thiz, jint ctx, jint coreType, jint id, jint size) {
    jbyteArray response = env->NewByteArray(size);
    if (size <= 0 || response == nullptr) {
        return response;
    }

    jbyte* ptr = static_cast<jbyte*>(env->GetPrimitiveArrayCritical(response, nullptr));
    if (ptr != nullptr) {
        getCorePayload(
            static_cast<uint8_t>(ctx),
            static_cast<uint8_t>(coreType),
            static_cast<uint8_t>(id),
            static_cast<void*>(ptr),
            size
        );
        env->ReleasePrimitiveArrayCritical(response, ptr, 0);
    }

    return response;
}

#include <mutex>

JavaVM* javaVm;

struct CallbackResponder {
    jobject activity;
    jclass cls;
    jint id;
};
std::vector<CallbackResponder> responders = {};
std::mutex respondersMutex;

void streamDataCallback(uint8_t ctx, uint8_t id, int size) {
    std::vector<CallbackResponder> respondersCopy;
    {
        std::lock_guard<std::mutex> lock(respondersMutex);
        respondersCopy = responders;
    }

    __android_log_print(ANDROID_LOG_VERBOSE, "org.fullstacked.core", "streamDataCallback responders count [%zu]", respondersCopy.size());

    for (const CallbackResponder& responder : respondersCopy) {
        JNIEnv *env = nullptr;
        if (javaVm->AttachCurrentThread(&env, nullptr) == JNI_OK) {
            jmethodID methodid = env->GetMethodID(responder.cls, "onStreamData", "(III)V");
            if (methodid != nullptr) {
                env->CallVoidMethod(responder.activity, methodid, static_cast<jint>(ctx), static_cast<jint>(id), static_cast<jint>(size));
            }
        }
    }
}

JNIEXPORT void JNICALL Java_org_fullstacked_Core_setOnStreamData
        (JNIEnv *env, jobject thiz) {
    __android_log_print(ANDROID_LOG_VERBOSE, "org.fullstacked.core", "setOnStreamData");
    setOnStreamData(reinterpret_cast<void*>(streamDataCallback));
}

JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void* reserved) {
    __android_log_print(ANDROID_LOG_VERBOSE, "org.fullstacked.core", "onLoad");
    javaVm = vm;
    setOnStreamData(reinterpret_cast<void*>(streamDataCallback));
    return JNI_VERSION_1_6;
}

JNIEXPORT void JNICALL Java_org_fullstacked_MainActivity_addCallback
        (JNIEnv * env, jobject thiz, jint id) {
    __android_log_print(ANDROID_LOG_VERBOSE, "org.fullstacked.core", "add callback");

    CallbackResponder responder{
        env->NewGlobalRef(thiz),
        (jclass)(env->NewGlobalRef(env->FindClass("org/fullstacked/MainActivity"))),
        id
    };

    std::lock_guard<std::mutex> lock(respondersMutex);
    responders.push_back(responder);
}

JNIEXPORT void JNICALL Java_org_fullstacked_MainActivity_removeCallback
        (JNIEnv * env, jobject thiz, jint id) {
    __android_log_print(ANDROID_LOG_VERBOSE, "org.fullstacked.core", "remove callback");

    std::lock_guard<std::mutex> lock(respondersMutex);
    for (size_t i = 0; i < responders.size(); i++) {
        if (responders.at(i).id == id) {
            env->DeleteGlobalRef(responders.at(i).activity);
            env->DeleteGlobalRef(responders.at(i).cls);
            responders.erase(responders.begin() + i);
            return;
        }
    }
}

}