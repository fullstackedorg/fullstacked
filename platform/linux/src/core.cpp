#include "./core.h"
#include "./utils.h"
#include <algorithm>
#include <iostream>
#include <mutex>

extern "C" {
extern uint8_t start(char *root, char *build);
extern uint8_t startSafe(char *root, char *build);
extern void startWithCtx(char *root, char *build, uint8_t ctxId);
extern int check(uint8_t ctxId);
extern void stop(uint8_t ctxId);
extern void setOnStreamData(void *cb);
extern void getCorePayload(uint8_t ctx, uint8_t coreType, uint8_t id, void *ptr,
                           int size);
extern int call(void *buffer, int length);
extern void *callWithResponse(void *buffer, int length, int *size);
extern void *callMessage(void *buffer, int length, int *size);
extern int streamAttach(uint8_t ctxId);
extern void *streamRead(uint8_t ctxId, int gen, int *size);
extern void streamDetach(uint8_t ctxId, int gen);
extern void freePtr(void *ptr);
extern void setPlatform(char *name, int binaryCalls);
extern void *handleRequest(uint8_t ctxId, char *path, void *body, int length,
                           int *status, int *size);
}

static Core::StreamDataCallback s_streamCallback = nullptr;
static std::mutex s_callbackMutex;

static void c_onStreamData(uint8_t ctx, uint8_t streamId, int size) {
    std::vector<uint8_t> buffer(size);
    if (size > 0) {
        getCorePayload(ctx, 2 /* CoreResponseStream */, streamId, buffer.data(),
                       size);
    }
    std::lock_guard<std::mutex> lock(s_callbackMutex);
    if (s_streamCallback) {
        s_streamCallback(ctx, streamId, buffer);
    }
}

void Core::init() {
    setOnStreamData(reinterpret_cast<void *>(c_onStreamData));
}

uint8_t Core::start(const std::string &root, const std::string &build) {
    return ::start(const_cast<char *>(root.c_str()),
                   const_cast<char *>(build.c_str()));
}

uint8_t Core::startSafe(const std::string &root, const std::string &build) {
    return ::startSafe(const_cast<char *>(root.c_str()),
                       const_cast<char *>(build.c_str()));
}

void Core::startWithCtx(const std::string &root, const std::string &build,
                        uint8_t ctxId) {
    ::startWithCtx(const_cast<char *>(root.c_str()),
                   const_cast<char *>(build.c_str()), ctxId);
}

void Core::deepLink(uint8_t ctxId, const std::string &url) {
    std::vector<uint8_t> payload = {ctxId,
                                    0, // req id, unused by callWithResponse
                                    0, // Core Module
                                    6, // Fn DeepLink
                                    0, // Async
                                    static_cast<uint8_t>(STRING)};
    uint8_t urlLen[4];
    numberToUint4Bytes(url.size(), urlLen);
    payload.insert(payload.end(), urlLen, urlLen + 4);
    payload.insert(payload.end(), url.begin(), url.end());
    callCore(payload);
}

int Core::check(uint8_t ctxId) {
    return ::check(ctxId);
}

void Core::stop(uint8_t ctxId) {
    ::stop(ctxId);
}

// Thread safe: the core synchronizes per context, responses are returned
// directly instead of being stored by request id.
std::vector<uint8_t> Core::callCore(const std::vector<uint8_t> &payload) {
    if (payload.empty()) {
        return {};
    }

    int responseSize = 0;
    void *responsePtr = ::callWithResponse(
        const_cast<void *>(static_cast<const void *>(payload.data())),
        static_cast<int>(payload.size()), &responseSize);
    if (responsePtr == nullptr || responseSize <= 0) {
        return {};
    }

    const uint8_t *bytes = static_cast<const uint8_t *>(responsePtr);
    std::vector<uint8_t> response(bytes, bytes + responseSize);
    freePtr(responsePtr);
    return response;
}

int Core::streamAttach(uint8_t ctxId) {
    return ::streamAttach(ctxId);
}

void *Core::streamRead(uint8_t ctxId, int gen, int *size) {
    return ::streamRead(ctxId, gen, size);
}

void Core::streamDetach(uint8_t ctxId, int gen) {
    ::streamDetach(ctxId, gen);
}

void Core::freeBuffer(void *ptr) {
    freePtr(ptr);
}

std::vector<uint8_t> Core::callMessage(const std::vector<uint8_t> &payload,
                                       bool &framed) {
    framed = false;
    if (payload.empty()) {
        return {};
    }

    int responseSize = 0;
    void *responsePtr = ::callMessage(
        const_cast<void *>(static_cast<const void *>(payload.data())),
        static_cast<int>(payload.size()), &responseSize);
    if (responseSize < 0) {
        framed = true;
        return {};
    }
    if (responsePtr == nullptr) {
        return {};
    }

    const uint8_t *bytes = static_cast<const uint8_t *>(responsePtr);
    std::vector<uint8_t> response(bytes, bytes + responseSize);
    freePtr(responsePtr);
    return response;
}

void Core::setStreamCallback(StreamDataCallback cb) {
    std::lock_guard<std::mutex> lock(s_callbackMutex);
    s_streamCallback = cb;
}

void Core::setPlatform(const std::string &name, bool binaryCalls) {
    ::setPlatform(const_cast<char *>(name.c_str()), binaryCalls ? 1 : 0);
}

Core::Response Core::request(uint8_t ctxId, const std::string &path,
                             const std::vector<uint8_t> &body) {
    int status = 0;
    int size = 0;
    void *responsePtr = ::handleRequest(
        ctxId, const_cast<char *>(path.c_str()),
        const_cast<void *>(static_cast<const void *>(body.data())),
        static_cast<int>(body.size()), &status, &size);
    const uint8_t *bytes = static_cast<const uint8_t *>(responsePtr);
    // "<mime type>\n<body>"
    const uint8_t *end = bytes + size;
    const uint8_t *newline = std::find(bytes, end, '\n');
    Response response{status, std::string(bytes, newline), {}};
    if (newline != end) {
        response.data.assign(newline + 1, end);
    }
    freePtr(responsePtr);
    return response;
}
