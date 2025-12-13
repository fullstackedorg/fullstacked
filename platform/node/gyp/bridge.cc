#include <napi.h>
#include <functional>
#include <iostream>
#include <map>

#ifdef _MSC_VER
#include "./win.h"
#else
#include "./unix.h"
#endif

using namespace Napi;

CoreLib lib;

void N_Directories(const Napi::CallbackInfo &info) {
    Napi::String arg1 = info[0].As<Napi::String>().ToString();
    Napi::String arg2 = info[1].As<Napi::String>().ToString();
    Napi::String arg3 = info[2].As<Napi::String>().ToString();
    Napi::String arg4 = info[3].As<Napi::String>().ToString();
    lib.directories(
        (char *)arg1.Utf8Value().c_str(), (char *)arg2.Utf8Value().c_str(),
        (char *)arg3.Utf8Value().c_str(), (char *)arg4.Utf8Value().c_str());
}

using Context = Reference<Value>;
using DataType = int;
using FinalizerDataType = void;

void CallJs(Napi::Env env, Function callback, Context *context,
            DataType *data) {
    // Is the JavaScript environment still available to call into, eg. the TSFN
    // is not aborted
    if (env != nullptr) {
        // On Node-API 5+, the `callback` parameter is optional; however, this
        // example does ensure a callback is provided.
        if (callback != nullptr) {
            callback.Call(context->Value(), {Number::New(env, *data)});
        }
    }
    if (data != nullptr) {
        // We're finished with the data.
        delete data;
    }
}
using TSFN = TypedThreadSafeFunction<Context, DataType, CallJs>;

TSFN tsfn;

struct CallbackMessage {
        std::string projectId;
        std::string messageType;
        std::string message;
};
std::map<int, CallbackMessage> callbackMessages{};
std::mutex callbackMessagesMutex;
int callbackId = 0;

void n_callback(char *arg1, char *arg2, void *arg3, int arg4) {
    std::string message(static_cast<const char *>(arg3), arg4);

    CallbackMessage msg = {arg1, arg2, message};
    int id = callbackId++;

    callbackMessagesMutex.lock();
    callbackMessages[id] = msg;
    callbackMessagesMutex.unlock();

    int *num = new int(id);
    tsfn.NonBlockingCall(num);
}

void N_Callback(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    Context *context = new Reference<Value>(Persistent(info.This()));
    // Create a ThreadSafeFunction
    tsfn = TSFN::New(
        env,
        info[0].As<Function>(), // JavaScript function called asynchronously
        "Callback",             // Name
        0,                      // Unlimited queue
        1,                      // Only one thread will use this initially
        context,
        [](Napi::Env, FinalizerDataType *, Context *ctx) { delete ctx; });

    lib.callback((void *)n_callback);
}

void N_Callback_Value(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    int id = info[0].As<Napi::Number>().Int32Value();
    Napi::Function cb = info[1].As<Napi::Function>();

    callbackMessagesMutex.lock();
    CallbackMessage msg = callbackMessages[id];
    callbackMessagesMutex.unlock();

    cb.Call(env.Global(), {
                              Napi::String::New(env, msg.projectId),
                              Napi::String::New(env, msg.messageType),
                              Napi::String::New(env, msg.message),
                          });

    callbackMessagesMutex.lock();
    callbackMessages.erase(id);
    callbackMessagesMutex.unlock();
}

Napi::ArrayBuffer N_Call(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    Napi::ArrayBuffer buffer = info[0].As<Napi::ArrayBuffer>();
    int size = lib.call(buffer.Data(), buffer.ByteLength());
    uint8_t id = ((uint8_t *)(buffer.Data()))[0];
    Napi::ArrayBuffer response = Napi::ArrayBuffer::New(env, size);
    lib.getResponse(id, response.Data());
    return response;
}

void N_Load(const Napi::CallbackInfo &info) {
    Napi::String libPath = info[0].As<Napi::String>().ToString();
    lib = loadLibrary(libPath.Utf8Value());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "load"),
                Napi::Function::New(env, N_Load));

    exports.Set(Napi::String::New(env, "directories"),
                Napi::Function::New(env, N_Directories));

    exports.Set(Napi::String::New(env, "callback"),
                Napi::Function::New(env, N_Callback));

    exports.Set(Napi::String::New(env, "callbackValue"),
                Napi::Function::New(env, N_Callback_Value));

    exports.Set(Napi::String::New(env, "call"),
                Napi::Function::New(env, N_Call));
    return exports;
}

NODE_API_MODULE(hello, Init)