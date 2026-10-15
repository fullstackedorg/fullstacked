#include "./bridge.h"
#include "../base64.h"
#include "../core.h"
#include <cerrno>
#include <functional>
#include <gio/gunixinputstream.h>
#include <memory>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>

// pool and main loop tasks are std::function<void()>
static void runPoolTask(gpointer data, gpointer) {
    auto *task = static_cast<std::function<void()> *>(data);
    (*task)();
    delete task;
}

static void runOnPool(GThreadPool *pool, std::function<void()> task) {
    g_thread_pool_push(pool, new std::function<void()>(std::move(task)),
                       nullptr);
}

// default priority: idle sources wait while calls keep coming
static void runOnMain(std::function<void()> task) {
    g_idle_add_full(
        G_PRIORITY_DEFAULT,
        [](gpointer data) -> gboolean {
            runPoolTask(data, nullptr);
            return G_SOURCE_REMOVE;
        },
        new std::function<void()>(std::move(task)), nullptr);
}

GtkBridge::GtkBridge(uint8_t pCtx, WebKitWebView *pWebview)
    : ctx(pCtx), webview(pWebview) {
    // one thread: the calls of the page keep their order
    corePool = g_thread_pool_new(runPoolTask, nullptr, 1, FALSE, nullptr);
    g_object_set_data(G_OBJECT(webview), "fullstacked_bridge", this);
    WebKitUserContentManager *ucm =
        webkit_web_view_get_user_content_manager(webview);
    webkit_user_content_manager_register_script_message_handler_with_reply(
        ucm, "call", NULL);
    g_signal_connect(ucm, "script-message-with-reply-received::call",
                     G_CALLBACK(GtkBridge::onCallMessage), this);
}

GtkBridge::~GtkBridge() {
    g_signal_handlers_disconnect_by_data(
        webkit_web_view_get_user_content_manager(webview), this);
    g_object_set_data(G_OBJECT(webview), "fullstacked_bridge", nullptr);
    // queued calls still run, their replies go to the page if it is still there
    g_thread_pool_free(corePool, FALSE, FALSE);
}

void GtkBridge::respond(WebKitURISchemeRequest *request, int status,
                        const std::string &mimeType, const void *data,
                        size_t length) {
    GInputStream *stream = g_memory_input_stream_new_from_data(
        g_memdup2(data, length), length, g_free);
    WebKitURISchemeResponse *response =
        webkit_uri_scheme_response_new(stream, length);
    webkit_uri_scheme_response_set_status(response, status, nullptr);
    webkit_uri_scheme_response_set_content_type(response, mimeType.c_str());
    webkit_uri_scheme_request_finish_with_response(request, response);
    g_object_unref(response);
    g_object_unref(stream);
}

// on the main thread
void GtkBridge::request(WebKitURISchemeRequest *request,
                        const std::string &path) {
    if (path == "/stream") {
        startFrameStream(request);
        return;
    }

    std::vector<uint8_t> body;
    if (GInputStream *stream =
            webkit_uri_scheme_request_get_http_body(request)) {
        uint8_t chunk[16384];
        gssize n;
        while ((n = g_input_stream_read(stream, chunk, sizeof(chunk), nullptr,
                                        nullptr)) > 0) {
            body.insert(body.end(), chunk, chunk + n);
        }
        g_object_unref(stream);
    }

    auto *req = WEBKIT_URI_SCHEME_REQUEST(g_object_ref(request));
    auto task = [req, ctx = ctx, path, body = std::move(body)]() {
        auto response =
            std::make_shared<Core::Response>(Core::request(ctx, path, body));
        runOnMain([req, response]() {
            respond(req, response->status, response->mimeType,
                    response->data.data(), response->data.size());
            g_object_unref(req);
        });
    };
    if (path == "/call" || path == "/sync") {
        runOnPool(corePool, std::move(task));
    } else {
        static GThreadPool *requestPool = g_thread_pool_new(
            runPoolTask, nullptr, static_cast<gint>(g_get_num_processors()),
            FALSE, nullptr);
        runOnPool(requestPool, std::move(task));
    }
}

gboolean GtkBridge::onCallMessage(WebKitUserContentManager *, JSCValue *value,
                                  WebKitScriptMessageReply *reply,
                                  gpointer userData) {
    auto *bridge = static_cast<GtkBridge *>(userData);
    char *message = jsc_value_to_string(value);
    std::string decoded = base64_decode(std::string(message ? message : ""));
    g_free(message);
    std::vector<uint8_t> payload(decoded.begin(), decoded.end());

    webkit_script_message_reply_ref(reply);
    auto *context = JSC_CONTEXT(g_object_ref(jsc_value_get_context(value)));
    runOnPool(bridge->corePool, [reply, context,
                                 payload = std::move(payload)]() {
        bool framed = false;
        auto response = Core::callMessage(payload, framed);
        auto encoded = std::make_shared<std::string>(
            framed ? "" : base64_encode(response.data(), response.size()));
        runOnMain([reply, context, encoded]() {
            JSCValue *result = jsc_value_new_string(context, encoded->c_str());
            webkit_script_message_reply_return_value(reply, result);
            g_object_unref(result);
            g_object_unref(context);
            webkit_script_message_reply_unref(reply);
        });
    });
    // replied later
    return TRUE;
}

// WebKit reads the response from one end of a socket pair as data comes, a
// thread writes the frames to the other end until the context ends, the page
// reloads, or the page goes away (the write fails).
void GtkBridge::startFrameStream(WebKitURISchemeRequest *request) {
    int gen = Core::streamAttach(ctx);
    int fds[2];
    if (gen < 0 ||
        socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, fds) != 0) {
        if (gen >= 0) Core::streamDetach(ctx, gen);
        respond(request, 404, "text/plain", "Not Found", 9);
        return;
    }

    GInputStream *input = g_unix_input_stream_new(fds[0], TRUE);
    webkit_uri_scheme_request_finish(request, input, -1,
                                     "application/octet-stream");
    g_object_unref(input);

    std::thread([ctx = ctx, gen, fd = fds[1]]() {
        void *frames;
        int size = 0;
        while ((frames = Core::streamRead(ctx, gen, &size)) != nullptr) {
            const char *data = static_cast<const char *>(frames);
            size_t left = static_cast<size_t>(size);
            while (left > 0) {
                ssize_t n = send(fd, data, left, MSG_NOSIGNAL);
                if (n < 0 && errno == EINTR) continue;
                if (n < 0) break;
                data += n;
                left -= static_cast<size_t>(n);
            }
            Core::freeBuffer(frames);
            if (left > 0) {
                // the page went away, stream data goes back to evaluated chunks
                Core::streamDetach(ctx, gen);
                break;
            }
        }
        ::close(fd);
    }).detach();
}

// any thread, a statement that throws does not stop the others of the batch
void GtkBridge::onStreamData(uint8_t streamId,
                             const std::vector<uint8_t> &data) {
    {
        std::lock_guard<std::mutex> lock(scriptMutex);
        pendingScript += "try{window.fullstacked.onStreamData(" +
                         std::to_string(streamId) + ", `" +
                         base64_encode(data.data(), data.size()) +
                         "`)}catch(e){console.error(e)};";
        if (scriptFlushScheduled) return;
        scriptFlushScheduled = true;
    }
    // the bridge is looked up from the webview, it may be gone by then
    g_idle_add_full(G_PRIORITY_DEFAULT, flushScripts, g_object_ref(webview),
                    nullptr);
}

gboolean GtkBridge::flushScripts(gpointer userData) {
    auto *view = WEBKIT_WEB_VIEW(userData);
    auto *bridge = static_cast<GtkBridge *>(
        g_object_get_data(G_OBJECT(view), "fullstacked_bridge"));
    if (bridge) {
        std::string script;
        {
            std::lock_guard<std::mutex> lock(bridge->scriptMutex);
            script.swap(bridge->pendingScript);
            bridge->scriptFlushScheduled = false;
        }
        webkit_web_view_evaluate_javascript(
            view, script.c_str(), static_cast<gssize>(script.size()), nullptr,
            nullptr, nullptr, nullptr, nullptr);
    }
    g_object_unref(view);
    return G_SOURCE_REMOVE;
}
