#ifndef CORE_H
#define CORE_H

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

class Core {
    public:
        using StreamDataCallback = std::function<void(
            uint8_t ctx, uint8_t streamId, const std::vector<uint8_t> &data)>;

        static void init();
        static uint8_t start(const std::string &root, const std::string &build);
        static uint8_t startSafe(const std::string &root,
                                 const std::string &build);
        static void startWithCtx(const std::string &root,
                                 const std::string &build, uint8_t ctxId);
        // Calls Core Fn DeepLink in ctx: the deeplink plugins of ctx receive
        // url
        static void deepLink(uint8_t ctxId, const std::string &url);
        static int check(uint8_t ctxId);
        static void stop(uint8_t ctxId);
        static std::vector<uint8_t>
        callCore(const std::vector<uint8_t> &payload);
        // a call received on a message channel: framed is true when the
        // core put a large response on the frame stream, the reply is empty
        static std::vector<uint8_t>
        callMessage(const std::vector<uint8_t> &payload, bool &framed);
        static void setStreamCallback(StreamDataCallback cb);

        // Stream data of a context as binary frames for GET /stream, see
        // core/internal/frames. streamAttach returns the reader generation
        // (-1 for an unknown context), streamRead blocks until frames are
        // queued and returns them (free with freeBuffer), nullptr once the
        // reader ended.
        static int streamAttach(uint8_t ctxId);
        static void *streamRead(uint8_t ctxId, int gen, int *size);
        static void streamDetach(uint8_t ctxId, int gen);
        static void freeBuffer(void *ptr);
};

#endif
