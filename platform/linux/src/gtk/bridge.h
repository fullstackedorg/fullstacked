#ifndef GtkBridge_H_
#define GtkBridge_H_

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>
#include <webkit/webkit.h>

// The bridge between a page and the core (see core/internal/bundle/lib/bridge
// and perfs/porting.md):
// - small async calls: the "call" script message handler, replied with the
//   response in base64 (empty when the core put a large response on the frame
//   stream)
// - GET /stream: the stream data as binary frames
// - every other request of the page (static files, POST /call and /sync...) is
//   answered by the core
class GtkBridge {
    public:
        GtkBridge(uint8_t ctx, WebKitWebView *webview);
        ~GtkBridge();

        void request(WebKitURISchemeRequest *request, const std::string &path);
        // any thread
        void onStreamData(uint8_t streamId, const std::vector<uint8_t> &data);

        static void respond(WebKitURISchemeRequest *request, int status,
                            const std::string &mimeType, const void *data,
                            size_t length);

    private:
        uint8_t ctx;
        WebKitWebView *webview;
        // the calls of the page run in order, off the main thread
        GThreadPool *corePool;

        // stream chunks when the page reads no frames, evaluated once per main
        // loop iteration
        std::mutex scriptMutex;
        std::string pendingScript;
        bool scriptFlushScheduled = false;

        void startFrameStream(WebKitURISchemeRequest *request);
        static gboolean onCallMessage(WebKitUserContentManager *manager,
                                      JSCValue *value,
                                      WebKitScriptMessageReply *reply,
                                      gpointer userData);
        static gboolean flushScripts(gpointer userData);
};

#endif
