#include "./core.h"
#include <iostream>
#include <mutex>

extern "C" {
    extern uint8_t start(char* root, char* build);
    extern void startWithCtx(char* root, char* build, uint8_t ctxId);
    extern int check(uint8_t ctxId);
    extern void stop(uint8_t ctxId);
    extern void setOnStreamData(void* cb);
    extern void getCorePayload(uint8_t ctx, uint8_t coreType, uint8_t id, void* ptr, int size);
    extern int call(void* buffer, int length);
    extern void freePtr(void* ptr);
}

static Core::StreamDataCallback s_streamCallback = nullptr;
static std::mutex s_callbackMutex;

static void c_onStreamData(uint8_t ctx, uint8_t streamId, int size) {
    std::vector<uint8_t> buffer(size);
    if (size > 0) {
        getCorePayload(ctx, 2 /* CoreResponseStream */, streamId, buffer.data(), size);
    }
    std::lock_guard<std::mutex> lock(s_callbackMutex);
    if (s_streamCallback) {
        s_streamCallback(ctx, streamId, buffer);
    }
}

void Core::init() {
    setOnStreamData(reinterpret_cast<void*>(c_onStreamData));
}

uint8_t Core::start(const std::string &root, const std::string &build) {
    return ::start(const_cast<char*>(root.c_str()), const_cast<char*>(build.c_str()));
}

void Core::startWithCtx(const std::string &root, const std::string &build, uint8_t ctxId) {
    ::startWithCtx(const_cast<char*>(root.c_str()), const_cast<char*>(build.c_str()), ctxId);
}

int Core::check(uint8_t ctxId) {
    return ::check(ctxId);
}

void Core::stop(uint8_t ctxId) {
    ::stop(ctxId);
}

std::vector<uint8_t> Core::callCore(const std::vector<uint8_t> &payload) {
    if (payload.empty()) {
        return {};
    }

    int responseSize = ::call(const_cast<void*>(static_cast<const void*>(payload.data())), static_cast<int>(payload.size()));
    if (responseSize <= 0) {
        return {};
    }

    std::vector<uint8_t> response(responseSize);
    uint8_t ctx = payload[0];
    uint8_t id = payload[1];
    getCorePayload(ctx, 1 /* CoreResponseData */, id, response.data(), responseSize);
    return response;
}

void Core::setStreamCallback(StreamDataCallback cb) {
    std::lock_guard<std::mutex> lock(s_callbackMutex);
    s_streamCallback = cb;
}
