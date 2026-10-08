#include <napi.h>
#include <cstring>
#include <functional>
#include <iostream>
#include <map>
#include <string>
#include <thread>
#include <vector>

#ifdef _MSC_VER
#include "./win.h"
#else
#include "./unix.h"
#endif

using namespace Napi;

CoreLib lib;

Napi::Number N_Start(const Napi::CallbackInfo &info) {
    Napi::String root = info[0].As<Napi::String>().ToString();
    Napi::String build = root;
    if (info.Length() > 1 && !info[1].IsUndefined()) {
        build = info[1].As<Napi::String>().ToString();
    }
    return Napi::Number::New(info.Env(),
                             lib.start((char *)root.Utf8Value().c_str(),
                                       (char *)build.Utf8Value().c_str()));
}

Napi::Boolean N_Check(const Napi::CallbackInfo &info) {
    uint32_t ctxId = info[0].As<Napi::Number>().Uint32Value();
    return Napi::Boolean::New(info.Env(),
                              lib.check(static_cast<uint8_t>(ctxId)));
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
    if (streamId != 0) {
        lib.getCorePayload(ctx, 2, streamId, buffer.data(), size);
    }
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
    lib.getCorePayload(ctx, 1, id, response.Data(), size);
    return response;
}

// Stream data of a context as binary frames for GET /stream, see
// core/internal/frames
Napi::Number N_StreamAttach(const Napi::CallbackInfo &info) {
    uint32_t ctxId = info[0].As<Napi::Number>().Uint32Value();
    return Napi::Number::New(info.Env(),
                             lib.streamAttach(static_cast<uint8_t>(ctxId)));
}

void N_StreamDetach(const Napi::CallbackInfo &info) {
    uint32_t ctxId = info[0].As<Napi::Number>().Uint32Value();
    int gen = info[1].As<Napi::Number>().Int32Value();
    lib.streamDetach(static_cast<uint8_t>(ctxId), gen);
}

struct FramesChunk {
        std::vector<uint8_t> data;
        bool end;
};

void CallFrames(Napi::Env env, Function callback, std::nullptr_t *context,
                FramesChunk *chunk) {
    if (env != nullptr && callback != nullptr) {
        if (chunk->end) {
            callback.Call({env.Null()});
        } else {
            Napi::ArrayBuffer buffer =
                Napi::ArrayBuffer::New(env, chunk->data.size());
            memcpy(buffer.Data(), chunk->data.data(), chunk->data.size());
            callback.Call({buffer});
        }
    }
    delete chunk;
}
using FramesTSFN = TypedThreadSafeFunction<std::nullptr_t, FramesChunk,
                                           CallFrames>;

// reads the frames on its own thread (streamRead blocks), calls back with
// each batch and null once the reader ended
void N_StreamStart(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    uint8_t ctxId =
        static_cast<uint8_t>(info[0].As<Napi::Number>().Uint32Value());
    int gen = info[1].As<Napi::Number>().Int32Value();

    FramesTSFN tsfn =
        FramesTSFN::New(env, info[2].As<Function>(), "StreamFrames", 0, 1);
    // does not keep the process alive
    tsfn.Unref(env);

    std::thread([tsfn, ctxId, gen]() mutable {
        while (true) {
            int size = 0;
            void *frames = lib.streamRead(ctxId, gen, &size);
            if (frames == nullptr) break;
            uint8_t *bytes = static_cast<uint8_t *>(frames);
            auto *chunk = new FramesChunk{
                std::vector<uint8_t>(bytes, bytes + size), false};
            lib.freePtr(frames);
            if (tsfn.BlockingCall(chunk) != napi_ok) {
                delete chunk;
                lib.streamDetach(ctxId, gen);
                break;
            }
        }
        auto *end = new FramesChunk{{}, true};
        if (tsfn.BlockingCall(end) != napi_ok) {
            delete end;
        }
        tsfn.Release();
    }).detach();
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

    exports.Set(Napi::String::New(env, "check"),
                Napi::Function::New(env, N_Check));

    exports.Set(Napi::String::New(env, "stop"),
                Napi::Function::New(env, N_Stop));

    exports.Set(Napi::String::New(env, "setOnStreamData"),
                Napi::Function::New(env, N_Callback));

    exports.Set(Napi::String::New(env, "call"),
                Napi::Function::New(env, N_Call));

    exports.Set(Napi::String::New(env, "streamAttach"),
                Napi::Function::New(env, N_StreamAttach));

    exports.Set(Napi::String::New(env, "streamStart"),
                Napi::Function::New(env, N_StreamStart));

    exports.Set(Napi::String::New(env, "streamDetach"),
                Napi::Function::New(env, N_StreamDetach));

    exports.Set(Napi::String::New(env, "end"), Napi::Function::New(env, N_End));
    return exports;
}

NODE_API_MODULE(hello, Init)