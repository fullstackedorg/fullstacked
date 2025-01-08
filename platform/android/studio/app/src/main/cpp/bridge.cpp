#include <android/log.h>
#include "bridge.h"

#include <android/log.h>
#include <cstring>
#include <string>
#include <functional>

extern "C" {


JNIEXPORT void JNICALL Java_org_fullstacked_editor_MainActivity_directories
        (JNIEnv *env, jobject jobj, jstring root, jstring config, jstring editor) {

    const char* rootPtr = env->GetStringUTFChars(root, nullptr);
    const char* configPtr = env->GetStringUTFChars(config, nullptr);
    const char* editorPtr = env->GetStringUTFChars(editor, nullptr);

    directories(
            const_cast<char*>(rootPtr),
            const_cast<char*>(configPtr),
            const_cast<char*>(editorPtr)
    );
}


JNIEXPORT jbyteArray JNICALL Java_org_fullstacked_editor_Instance_call
        (JNIEnv *env, jobject obj, jbyteArray buffer)
{

    int length = env->GetArrayLength(buffer);
    void* responsePtr;

    int size = call(env->GetByteArrayElements(buffer, nullptr), length, &responsePtr);

    jbyteArray response = env->NewByteArray(size);
    env->SetByteArrayRegion(response, 0, size, (jbyte*)responsePtr);

    freePtr(responsePtr);

    return response;
}

JavaVM* javaVm;

struct CallbackResponder {
    jobject activity;
    jclass cls;
    jint id;
};
std::vector<CallbackResponder> responders = {};

void goCallback(char* projectId, char* messageType, char* message) {
    __android_log_print(ANDROID_LOG_VERBOSE, "org.fullstacked.editor.core", "goCallback responders count [%zu]", responders.size());

    for(CallbackResponder responder : responders) {
        // get JNI env
        JNIEnv *env = nullptr;
        if (javaVm->AttachCurrentThread(&env, nullptr) == JNI_OK) {
            // find method id on cached class
            jmethodID methodid = env->GetMethodID(responder.cls, "Callback", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V");

            // callback
            jstring jstr = env->NewStringUTF(projectId);
            jstring jstr2 = env->NewStringUTF(messageType);
            jstring jstr3 = env->NewStringUTF(message);
            env->CallVoidMethod(responder.activity, methodid, jstr, jstr2, jstr3);
        }
    }
}

JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void* reserved){
    __android_log_print(ANDROID_LOG_VERBOSE, "org.fullstacked.editor.core", "onLoad");
    javaVm = vm;
    callback((void*)goCallback);
    return JNI_VERSION_1_6;
}

JNIEXPORT void JNICALL Java_org_fullstacked_editor_MainActivity_addCallback
        (JNIEnv * env, jobject thiz, jint id)
{
    __android_log_print(ANDROID_LOG_VERBOSE, "org.fullstacked.editor.core", "add callback");

    CallbackResponder responder{
        env->NewGlobalRef(thiz),
        (jclass)(env->NewGlobalRef(env->FindClass("org/fullstacked/editor/MainActivity"))),
        id
    };

    responders.push_back(responder);
}

JNIEXPORT void JNICALL Java_org_fullstacked_editor_MainActivity_removeCallback
        (JNIEnv * env, jobject thiz, jint id)
{
    __android_log_print(ANDROID_LOG_VERBOSE, "org.fullstacked.editor.core", "remove callback");

    for(int i = 0; i < responders.size(); i++) {
        if(responders.at(i).id == id) {
            responders.erase(responders.begin() + i);
            return;
        }
    }
}

}