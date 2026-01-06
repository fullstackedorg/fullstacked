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

Napi::Number N_Start(const Napi::CallbackInfo &info) {
    Napi::String directory = info[0].As<Napi::String>().ToString();
    return Napi::Number::New(info.Env(),
                             lib.start((char *)directory.Utf8Value().c_str()));
}

void N_Stop(const Napi::CallbackInfo &info) {
    uint32_t ctxId = info[0].As<Napi::Number>().Uint32Value();
    lib.stop(static_cast<uint8_t>(ctxId));
}

struct StreamChunk {
        uint8_t ctx;
        uint8_t id;
        std::vector<uint8_t> buffer;
};

using Context = Reference<Value>;
using DataType = StreamChunk;
using FinalizerDataType = void;

void CallJs(Napi::Env env, Function callback, Context *context,
            DataType *data) {
    StreamChunk chunk = *data;
    callback.Call({Number::New(env, chunk.ctx), Number::New(env, chunk.id),
                   Napi::ArrayBuffer::New(env, chunk.buffer.data(),
                                          chunk.buffer.size())});
    delete data;
}
using TSFN = TypedThreadSafeFunction<Context, DataType, CallJs>;

TSFN tsfn;

void n_onStreamData(uint8_t ctx, uint8_t streamId, int size) {
    std::vector<uint8_t> buffer(size, 0);
    // 2 for CoreType Stream
    lib.getCorePayload(ctx, 2, streamId, buffer.data());
    StreamChunk *chunk = new StreamChunk;
    chunk->ctx = ctx;
    chunk->id = streamId;
    chunk->buffer = buffer;
    tsfn.NonBlockingCall(chunk);
}

void N_Callback(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    tsfn = TSFN::New(
        env,
        info[0].As<Function>(), // JavaScript function called asynchronously
        "OnStreamData",         // Name
        0,                      // Unlimited queue
        1,                      // Only one thread will use this initially
        nullptr,
        [](Napi::Env, FinalizerDataType *, Context *ctx) { delete ctx; });

    lib.setOnStreamData((void *)n_onStreamData);
}

void N_End(const Napi::CallbackInfo &info) {
    tsfn.Release();
}

Napi::ArrayBuffer N_Call(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    Napi::ArrayBuffer buffer = info[0].As<Napi::ArrayBuffer>();
    int size = lib.call(buffer.Data(), buffer.ByteLength());
    uint8_t *payload = (uint8_t *)(buffer.Data());
    uint8_t ctx = payload[0];
    uint8_t id = payload[1];
    Napi::ArrayBuffer response = Napi::ArrayBuffer::New(env, size);
    // 1 for CoreType Data
    lib.getCorePayload(ctx, 1, id, response.Data());
    return response;
}

void N_Load(const Napi::CallbackInfo &info) {
    Napi::String libPath = info[0].As<Napi::String>().ToString();
    lib = loadLibrary(libPath.Utf8Value());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "load"),
                Napi::Function::New(env, N_Load));

    exports.Set(Napi::String::New(env, "start"),
                Napi::Function::New(env, N_Start));

    exports.Set(Napi::String::New(env, "stop"),
                Napi::Function::New(env, N_Stop));

    exports.Set(Napi::String::New(env, "setOnStreamData"),
                Napi::Function::New(env, N_Callback));

    exports.Set(Napi::String::New(env, "call"),
                Napi::Function::New(env, N_Call));

    exports.Set(Napi::String::New(env, "end"), Napi::Function::New(env, N_End));
    return exports;
}

NODE_API_MODULE(hello, Init)