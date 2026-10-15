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
        void *data; // freed with freePtr, nullptr once the reader ended
        int size;
};

// Large buffers (frames, response bodies) go to JS as external Buffers over
// the core buffer, no copy. Small ones are copied: many small external
// buffers cost more in finalizers than the copy (4k chunk streams ran at
// half the speed).
const int EXTERNAL_FRAMES_MIN_SIZE = 64 << 10;

void CallFrames(Napi::Env env, Function callback, std::nullptr_t *context,
                FramesChunk *chunk) {
    if (env == nullptr || callback == nullptr) {
        if (chunk->data) lib.freePtr(chunk->data);
    } else if (chunk->data == nullptr) {
        callback.Call({env.Null()});
    } else if (chunk->size < EXTERNAL_FRAMES_MIN_SIZE) {
        auto frames = Napi::Buffer<uint8_t>::Copy(
            env, static_cast<uint8_t *>(chunk->data), chunk->size);
        lib.freePtr(chunk->data);
        callback.Call({frames});
    } else {
        callback.Call({Napi::Buffer<uint8_t>::New(
            env, static_cast<uint8_t *>(chunk->data), chunk->size,
            [](Napi::Env, uint8_t *data) { lib.freePtr(data); })});
    }
    delete chunk;
}
using FramesTSFN =
    TypedThreadSafeFunction<std::nullptr_t, FramesChunk, CallFrames>;

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
            auto *chunk = new FramesChunk{frames, size};
            if (tsfn.BlockingCall(chunk) != napi_ok) {
                lib.freePtr(frames);
                delete chunk;
                lib.streamDetach(ctxId, gen);
                break;
            }
        }
        auto *end = new FramesChunk{nullptr, 0};
        if (tsfn.BlockingCall(end) != napi_ok) {
            delete end;
        }
        tsfn.Release();
    }).detach();
}

void N_SetPlatform(const Napi::CallbackInfo &info) {
    std::string name = info[0].As<Napi::String>().Utf8Value();
    lib.setPlatform(const_cast<char *>(name.c_str()),
                    info[1].As<Napi::Boolean>().Value() ? 1 : 0);
}

// A request of the page answered by the core: [status, mime type, body]
// with the body an external Buffer over the core response
Napi::Value N_Request(const Napi::CallbackInfo &info) {
    Napi::Env env = info.Env();
    uint8_t ctxId =
        static_cast<uint8_t>(info[0].As<Napi::Number>().Uint32Value());
    std::string path = info[1].As<Napi::String>().Utf8Value();
    void *body = nullptr;
    size_t length = 0;
    if (info.Length() > 2 && info[2].IsTypedArray()) {
        Napi::TypedArray array = info[2].As<Napi::TypedArray>();
        body = static_cast<uint8_t *>(array.ArrayBuffer().Data()) +
               array.ByteOffset();
        length = array.ByteLength();
    }
    int status = 0;
    int size = 0;
    uint8_t *response = static_cast<uint8_t *>(
        lib.handleRequest(ctxId, const_cast<char *>(path.c_str()), body,
                          static_cast<int>(length), &status, &size));
    // "<mime type>\n<body>"
    uint8_t *newline = static_cast<uint8_t *>(
        memchr(response, '\n', static_cast<size_t>(size)));
    size_t mimeLength = newline ? newline - response : size;
    size_t offset = newline ? mimeLength + 1 : size;
    Napi::Array result = Napi::Array::New(env, 3);
    result.Set(0u, Napi::Number::New(env, status));
    result.Set(1u, Napi::String::New(env, reinterpret_cast<char *>(response),
                                     mimeLength));
    size_t bodySize = static_cast<size_t>(size) - offset;
    if (bodySize < EXTERNAL_FRAMES_MIN_SIZE) {
        result.Set(
            2u, Napi::Buffer<uint8_t>::Copy(env, response + offset, bodySize));
        lib.freePtr(response);
    } else {
        result.Set(2u, Napi::Buffer<uint8_t>::New(
                           env, response + offset, bodySize,
                           [](Napi::Env, uint8_t *, uint8_t *response) {
                               lib.freePtr(response);
                           },
                           response));
    }
    return result;
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

    exports.Set(Napi::String::New(env, "setPlatform"),
                Napi::Function::New(env, N_SetPlatform));

    exports.Set(Napi::String::New(env, "request"),
                Napi::Function::New(env, N_Request));

    exports.Set(Napi::String::New(env, "end"), Napi::Function::New(env, N_End));
    return exports;
}

NODE_API_MODULE(hello, Init)