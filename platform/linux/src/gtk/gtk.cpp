#include "./gtk.h"
#include "../app.h"
#include "../base64.h"
#include "../core.h"
#include "../utils.h"
#include <cerrno>
#include <gio/gio.h>
#include <gio/gunixinputstream.h>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>
#include <gobject/gsignal.h>
#include <gtk/gtkwidget.h>
#include <gtkmm/eventcontrollerkey.h>
#include <gdk/gdkkeysyms.h>
#include <iostream>
#include <memory>
#include <sstream>

Window *WebkitGTKGUI::createWindow(uint8_t ctx) {
    return new WebkitGTKWindow(ctx, app);
}

int WebkitGTKGUI::run(int &argc, char **argv, std::function<void()> onReady,
                      std::function<void(const std::string &)> onDeepLink) {
    // org.fullstacked is single instance: a second launch forwards its command
    // line here (fullstacked:// deeplinks) and exits. Unknown options such as
    // --kiosk are passed through since the app handles its command line.
    app = Gtk::Application::create(
        "org.fullstacked", Gio::Application::Flags::HANDLES_COMMAND_LINE);
    WebKitWebContext *context = webkit_web_context_get_default();
    webkit_web_context_register_uri_scheme(
        context, "fs", WebkitGTKWindow::webKitURISchemeRequestCallback, nullptr,
        nullptr);
    app->signal_startup().connect(onReady);
    app->signal_command_line().connect(
        [onDeepLink](
            const Glib::RefPtr<Gio::ApplicationCommandLine> &cmdline) -> int {
            // The first launch reads its own arguments in main.cpp
            if (!cmdline->is_remote()) {
                return 0;
            }
            int cmdArgc = 0;
            char **cmdArgv = cmdline->get_arguments(cmdArgc);
            for (int i = 1; i < cmdArgc; i++) {
                std::string arg(cmdArgv[i]);
                if (arg.rfind("fullstacked", 0) == 0) {
                    onDeepLink(arg);
                }
            }
            g_strfreev(cmdArgv);
            return 0;
        },
        false);
    return app->run(argc, argv);
}

WebkitGTKWindow::WebkitGTKWindow(uint8_t pCtx,
                                 Glib::RefPtr<Gtk::Application> pApp) {
    ctx = pCtx;
    app = pApp;
    initWindow();
}

WebkitGTKWindow::~WebkitGTKWindow() {
    close();
}

static void sendGtkResponse(WebKitURISchemeRequest *request, const void *data,
                            size_t length, const std::string &mimeType) {
    void *copy = g_malloc(length > 0 ? length : 1);
    if (length > 0 && data) {
        memcpy(copy, data, length);
    }
    GInputStream *inputStream =
        g_memory_input_stream_new_from_data(copy, length, g_free);
    webkit_uri_scheme_request_finish(request, inputStream, length,
                                     mimeType.c_str());
    g_object_unref(inputStream);
}

// Stream data of the context as binary frames (see core/internal/frames).
// WebKit reads the response from one end of a socket pair as data comes, a
// thread writes the frames to the other end until the context ends, the page
// reloads, or the page goes away (the write fails).
void WebkitGTKWindow::startFrameStream(WebKitURISchemeRequest *request) {
    int gen = Core::streamAttach(ctx);
    int fds[2];
    if (gen < 0 ||
        socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, fds) != 0) {
        if (gen >= 0) {
            Core::streamDetach(ctx, gen);
        }
        std::string notFound = "Not Found";
        sendGtkResponse(request, notFound.data(), notFound.size(),
                        "text/plain");
        return;
    }

    GInputStream *input = g_unix_input_stream_new(fds[0], TRUE);
    webkit_uri_scheme_request_finish(request, input, -1,
                                     "application/octet-stream");
    g_object_unref(input);

    uint8_t streamCtx = ctx;
    int fd = fds[1];
    std::thread([streamCtx, gen, fd]() {
        while (true) {
            int size = 0;
            void *frames = Core::streamRead(streamCtx, gen, &size);
            if (frames == nullptr) break;

            const char *data = static_cast<const char *>(frames);
            size_t left = static_cast<size_t>(size);
            while (left > 0) {
                ssize_t n = send(fd, data, left, MSG_NOSIGNAL);
                if (n < 0) {
                    if (errno == EINTR) continue;
                    break;
                }
                data += n;
                left -= static_cast<size_t>(n);
            }
            Core::freeBuffer(frames);

            if (left > 0) {
                // the page went away, stream data goes back to evaluated chunks
                Core::streamDetach(streamCtx, gen);
                break;
            }
        }
        ::close(fd);
    }).detach();
}

struct GtkStaticFileTask {
        WebKitURISchemeRequest *request; // ref'd
        std::vector<uint8_t> payload;
        bool found = false;
        std::string mimeType;
        std::vector<uint8_t> data;
};

void WebkitGTKWindow::webKitURISchemeRequestCallback(
    WebKitURISchemeRequest *request, gpointer userData) {
    WebKitWebView *wv = webkit_uri_scheme_request_get_web_view(request);
    WebkitGTKWindow *win = nullptr;
    if (wv) {
        win = static_cast<WebkitGTKWindow *>(
            g_object_get_data(G_OBJECT(wv), "fullstacked_window"));
    }
    if (!win && App::instance && !App::instance->activeWindows.empty()) {
        win = static_cast<WebkitGTKWindow *>(
            App::instance->activeWindows.begin()->second);
    }
    if (win) {
        win->handleSchemeRequest(request);
    }
}

void WebkitGTKWindow::onOpenMessage(WebKitUserContentManager *manager,
                                    JSCValue *value, gpointer userData) {
    if (jsc_value_is_number(value)) {
        uint8_t targetCtx = static_cast<uint8_t>(jsc_value_to_int32(value));
        App::instance->open(targetCtx);
    }
}

void WebkitGTKWindow::onExitMessage(WebKitUserContentManager *manager,
                                    JSCValue *value, gpointer userData) {
    auto *win = static_cast<WebkitGTKWindow *>(userData);
    win->close();
}

void WebkitGTKWindow::onAuthMessage(WebKitUserContentManager *manager,
                                    JSCValue *value, gpointer userData) {
    auto *win = static_cast<WebkitGTKWindow *>(userData);
    char *valStr = jsc_value_to_string(value);
    std::string payload(valStr ? valStr : "");
    g_free(valStr);

    if (!payload.empty()) {
        std::string script =
            "window.postMessage(Object.fromEntries(new URLSearchParams(`" +
            payload + "`)), \"*\");";
        win->evaluateJavaScript(script);
        win->authResolved = true;
        win->closeAuthWindow(false);
    }
}

void WebkitGTKWindow::onCloseMessage(WebKitUserContentManager *manager,
                                     JSCValue *value, gpointer userData) {
    auto *win = static_cast<WebkitGTKWindow *>(userData);
    win->closeAuthWindow(true);
}

void WebkitGTKWindow::onAuthWebViewClose(WebKitWebView *view,
                                         gpointer user_data) {
    auto *win = static_cast<WebkitGTKWindow *>(user_data);
    win->closeAuthWindow(true);
}

gboolean WebkitGTKWindow::navigationDecidePolicy(
    WebKitWebView *view, WebKitPolicyDecision *decision,
    WebKitPolicyDecisionType decision_type, gpointer user_data) {
    if (decision_type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION ||
        decision_type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) {
        auto *navigation = WEBKIT_NAVIGATION_POLICY_DECISION(decision);
        WebKitNavigationAction *action =
            webkit_navigation_policy_decision_get_navigation_action(navigation);
        WebKitURIRequest *req = webkit_navigation_action_get_request(action);
        const char *uri = webkit_uri_request_get_uri(req);

        if (uri) {
            std::string uriStr(uri);
            if (uriStr.find("localhost") == std::string::npos &&
                uriStr.find("fs://") != 0 && uriStr.find("data:") != 0 &&
                uriStr.find("about:") != 0 && uriStr.find("blob:") != 0) {
                std::string cmd = "xdg-open '" + uriStr + "' 2>/dev/null &";
                system(cmd.c_str());
                webkit_policy_decision_ignore(decision);
                return true;
            }
        }
    }
    return false;
}

GtkWidget *
WebkitGTKWindow::onCreateWebView(WebKitWebView *view,
                                 WebKitNavigationAction *navigation_action,
                                 gpointer user_data) {
    auto *win = static_cast<WebkitGTKWindow *>(user_data);
    return win->createAuthWebView(navigation_action);
}

GtkWidget *
WebkitGTKWindow::createAuthWebView(WebKitNavigationAction *navigation_action) {
    WebKitURIRequest *req =
        navigation_action
            ? webkit_navigation_action_get_request(navigation_action)
            : nullptr;
    const char *uri = req ? webkit_uri_request_get_uri(req) : nullptr;
    std::string uriStr = uri ? uri : "";

    if (!uriStr.empty() && uriStr.find("auth") == std::string::npos &&
        uriStr.find("localhost") == std::string::npos &&
        uriStr.find("fs://") != 0) {
        std::string cmd = "xdg-open '" + uriStr + "' 2>/dev/null &";
        system(cmd.c_str());
        return nullptr;
    }

    if (authWindowGTK) {
        authResolved = true;
        Gtk::Window *oldWin = authWindowGTK;
        authWindowGTK = nullptr;
        delete oldWin;
    }

    authResolved = false;
    authWindowGTK = new Gtk::Window();
    authWindowGTK->set_title("Authentication");
    authWindowGTK->set_default_size(500, 600);

    GtkWidget *authWebviewWidget = GTK_WIDGET(
        g_object_new(WEBKIT_TYPE_WEB_VIEW, "related-view", webview, NULL));
    WebKitWebView *authWebview = WEBKIT_WEB_VIEW(authWebviewWidget);

    WebKitWindowProperties *props =
        webkit_web_view_get_window_properties(authWebview);
    if (props) {
        GdkRectangle geometry;
        webkit_window_properties_get_geometry(props, &geometry);
        if (geometry.width > 0 && geometry.height > 0) {
            authWindowGTK->set_default_size(geometry.width, geometry.height);
        }
    }

    WebKitSettings *settings = webkit_web_view_get_settings(authWebview);
    webkit_settings_set_enable_developer_extras(settings, true);
    webkit_settings_set_javascript_can_open_windows_automatically(settings,
                                                                  true);
    webkit_settings_set_enable_webgl(settings, true);

    WebKitUserContentManager *ucm =
        webkit_web_view_get_user_content_manager(authWebview);
    webkit_user_content_manager_register_script_message_handler(ucm, "auth",
                                                                NULL);
    webkit_user_content_manager_register_script_message_handler(ucm, "close",
                                                                NULL);
    g_signal_connect(ucm, "script-message-received::auth",
                     G_CALLBACK(WebkitGTKWindow::onAuthMessage), this);
    g_signal_connect(ucm, "script-message-received::close",
                     G_CALLBACK(WebkitGTKWindow::onCloseMessage), this);

    WebKitUserScript *userScript = webkit_user_script_new(
        "window.opener = {\n"
        "    postMessage: function(data) {\n"
        "        var q = (data && typeof data === 'object') ? new "
        "URLSearchParams(data).toString() : String(data);\n"
        "        if (window.webkit && window.webkit.messageHandlers && "
        "window.webkit.messageHandlers.auth) {\n"
        "            window.webkit.messageHandlers.auth.postMessage(q);\n"
        "        } else {\n"
        "            location.href = 'fullstacked-auth://auth?' + q;\n"
        "        }\n"
        "    }\n"
        "};\n"
        "var origClose = window.close;\n"
        "window.close = function() {\n"
        "    if (window.webkit && window.webkit.messageHandlers && "
        "window.webkit.messageHandlers.close) {\n"
        "        window.webkit.messageHandlers.close.postMessage('');\n"
        "    } else if (origClose) {\n"
        "        origClose.apply(window, arguments);\n"
        "    }\n"
        "};\n",
        WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES,
        WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, nullptr, nullptr);
    webkit_user_content_manager_add_script(ucm, userScript);
    webkit_user_script_unref(userScript);

    g_signal_connect(authWebviewWidget, "decide-policy",
                     G_CALLBACK(WebkitGTKWindow::authNavigationDecidePolicy),
                     this);
    g_signal_connect(authWebviewWidget, "load-changed",
                     G_CALLBACK(WebkitGTKWindow::onAuthLoadChanged), this);
    g_signal_connect(authWebviewWidget, "load-failed",
                     G_CALLBACK(WebkitGTKWindow::onAuthLoadFailed), this);
    g_signal_connect(authWebviewWidget, "close",
                     G_CALLBACK(WebkitGTKWindow::onAuthWebViewClose), this);

    Gtk::Widget *widget = Glib::wrap(authWebviewWidget, false);
    authWindowGTK->set_child(*widget);
    app->add_window(*authWindowGTK);

    authWindowGTK->signal_close_request().connect(
        [this]() -> bool {
            closeAuthWindow(true);
            return false;
        },
        false);

    authWindowGTK->show();
    return authWebviewWidget;
}

bool WebkitGTKWindow::checkAuthUri(const std::string &u) {
    // Auth results: fullstacked-auth://auth?... fullstacked:// links are
    // deeplinks, not auth results.
    if (u.rfind("fullstacked-auth://", 0) == 0 ||
        u.rfind("fullstacked-ctx://", 0) == 0) {
        size_t qPos = u.find('?');
        std::string query =
            (qPos != std::string::npos) ? u.substr(qPos + 1) : "";
        std::string script =
            "window.postMessage(Object.fromEntries(new URLSearchParams(`" +
            query + "`)), \"*\");";
        evaluateJavaScript(script);
        authResolved = true;
        closeAuthWindow(false);
        return true;
    }
    if ((u.find("localhost") != std::string::npos ||
         u.find("127.0.0.1") != std::string::npos) &&
        (u.find("code=") != std::string::npos ||
         u.find("token=") != std::string::npos ||
         u.find("access_token=") != std::string::npos)) {
        size_t qPos = u.find('?');
        std::string query =
            (qPos != std::string::npos) ? u.substr(qPos + 1) : "";
        std::string script =
            "window.postMessage(Object.fromEntries(new URLSearchParams(`" +
            query + "`)), \"*\");";
        evaluateJavaScript(script);
        authResolved = true;
        closeAuthWindow(false);
        return true;
    }
    return false;
}

gboolean WebkitGTKWindow::authNavigationDecidePolicy(
    WebKitWebView *view, WebKitPolicyDecision *decision,
    WebKitPolicyDecisionType decision_type, gpointer user_data) {
    auto *win = static_cast<WebkitGTKWindow *>(user_data);
    if (decision_type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION ||
        decision_type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) {
        auto *navigation = WEBKIT_NAVIGATION_POLICY_DECISION(decision);
        WebKitNavigationAction *action =
            webkit_navigation_policy_decision_get_navigation_action(navigation);
        WebKitURIRequest *req = webkit_navigation_action_get_request(action);
        const char *uri = req ? webkit_uri_request_get_uri(req) : nullptr;
        if (uri) {
            std::string u(uri);
            if (win->checkAuthUri(u)) {
                webkit_policy_decision_ignore(decision);
                return true;
            }
        }
    }
    return false;
}

void WebkitGTKWindow::onAuthLoadChanged(WebKitWebView *view,
                                        WebKitLoadEvent load_event,
                                        gpointer user_data) {
    auto *win = static_cast<WebkitGTKWindow *>(user_data);
    const char *uri = webkit_web_view_get_uri(view);
    if (uri) {
        win->checkAuthUri(std::string(uri));
    }
}

gboolean WebkitGTKWindow::onAuthLoadFailed(WebKitWebView *view,
                                           WebKitLoadEvent load_event,
                                           const char *failing_uri,
                                           GError *error, gpointer user_data) {
    auto *win = static_cast<WebkitGTKWindow *>(user_data);
    if (failing_uri && win->checkAuthUri(std::string(failing_uri))) {
        return TRUE;
    }
    return FALSE;
}

void WebkitGTKWindow::closeAuthWindow(bool canceled) {
    if (authWindowGTK) {
        if (canceled && !authResolved) {
            authResolved = true;
            evaluateJavaScript("window.postMessage(new Error(`Authentication "
                               "Canceled`), \"*\");");
        }
        Gtk::Window *win = authWindowGTK;
        authWindowGTK = nullptr;
        delete win;
    }
}

void WebkitGTKWindow::initWindow() {
    windowGTK = new Gtk::Window();
    windowGTK->set_title("FullStacked");
    windowGTK->set_default_size(800, 600);
    windowGTK->show();
    windowGTK->signal_close_request().connect(
        [this]() -> bool {
            close();
            return false;
        },
        false);
    app->add_window(*windowGTK);

    GtkWidget *webviewWidget = webkit_web_view_new();
    webview = WEBKIT_WEB_VIEW(webviewWidget);
    g_object_set_data(G_OBJECT(webview), "fullstacked_window", this);

    // one thread: the calls of the window keep their order
    corePool = g_thread_pool_new(runCoreTask, nullptr, 1, FALSE, nullptr);

    Gtk::Widget *widget = Glib::wrap(webviewWidget, false);
    windowGTK->set_child(*widget);

    WebKitSettings *settings = webkit_web_view_get_settings(webview);
    webkit_settings_set_enable_developer_extras(settings, true);
    webkit_settings_set_javascript_can_open_windows_automatically(settings,
                                                                  true);
    webkit_settings_set_enable_webgl(settings, true);

    WebKitUserContentManager *ucm =
        webkit_web_view_get_user_content_manager(webview);
    // small async calls, see bridge/platform/linux.ts
    webkit_user_content_manager_register_script_message_handler_with_reply(
        ucm, "call", NULL);
    webkit_user_content_manager_register_script_message_handler(ucm, "open",
                                                                NULL);
    webkit_user_content_manager_register_script_message_handler(ucm, "exit",
                                                                NULL);

    g_signal_connect(ucm, "script-message-with-reply-received::call",
                     G_CALLBACK(WebkitGTKWindow::onCallMessage), this);
    g_signal_connect(ucm, "script-message-received::open",
                     G_CALLBACK(WebkitGTKWindow::onOpenMessage), this);
    g_signal_connect(ucm, "script-message-received::exit",
                     G_CALLBACK(WebkitGTKWindow::onExitMessage), this);
    g_signal_connect(webviewWidget, "decide-policy",
                     G_CALLBACK(WebkitGTKWindow::navigationDecidePolicy), this);
    g_signal_connect(webviewWidget, "create",
                     G_CALLBACK(WebkitGTKWindow::onCreateWebView), this);

    auto keyController = Gtk::EventControllerKey::create();
    keyController->set_propagation_phase(Gtk::PropagationPhase::CAPTURE);
    keyController->signal_key_pressed().connect(
        [](guint keyval, guint keycode, Gdk::ModifierType state) -> bool {
            bool isT = (keyval == GDK_KEY_t || keyval == GDK_KEY_T);
            bool isShift = (state & Gdk::ModifierType::SHIFT_MASK) !=
                           Gdk::ModifierType::NO_MODIFIER_MASK;
            bool isCtrlOrSuper = (state & (Gdk::ModifierType::CONTROL_MASK |
                                           Gdk::ModifierType::SUPER_MASK |
                                           Gdk::ModifierType::META_MASK)) !=
                                 Gdk::ModifierType::NO_MODIFIER_MASK;
            if (isT && isShift && isCtrlOrSuper) {
                if (App::instance) {
                    App::instance->safeTrigger();
                }
                return true;
            }
            return false;
        },
        false);
    windowGTK->add_controller(keyController);

    webkit_web_view_load_uri(webview, "fs://localhost");
}

WebkitGTKWindow *WebkitGTKWindow::fromWebView(WebKitWebView *view) {
    return static_cast<WebkitGTKWindow *>(
        g_object_get_data(G_OBJECT(view), "fullstacked_window"));
}

// runs on the window core pool, in order
void WebkitGTKWindow::runCoreTask(gpointer data, gpointer userData) {
    auto *task = static_cast<std::function<void()> *>(data);
    (*task)();
    delete task;
}

gboolean WebkitGTKWindow::runMainTask(gpointer data) {
    auto *task = static_cast<std::function<void()> *>(data);
    (*task)();
    delete task;
    return G_SOURCE_REMOVE;
}

// runs task on the core pool, results come back with runOnMain
void WebkitGTKWindow::pushCoreTask(std::function<void()> task) {
    auto *pending = new std::function<void()>(std::move(task));
    if (corePool) {
        g_thread_pool_push(corePool, pending, nullptr);
    } else {
        runCoreTask(pending, nullptr);
    }
}

// default priority: idle sources wait while calls keep coming
void WebkitGTKWindow::runOnMain(std::function<void()> task) {
    g_idle_add_full(G_PRIORITY_DEFAULT, runMainTask,
                    new std::function<void()>(std::move(task)), nullptr);
}

// POST /call and /sync: the body is the payload, the response the core
// response; sync is a sync XHR of the page, the same for the host
void WebkitGTKWindow::handleCall(WebKitURISchemeRequest *request) {
    std::vector<uint8_t> payload;
    GInputStream *body = webkit_uri_scheme_request_get_http_body(request);
    if (body) {
        uint8_t chunk[16384];
        gssize n;
        while ((n = g_input_stream_read(body, chunk, sizeof(chunk), nullptr,
                                        nullptr)) > 0) {
            payload.insert(payload.end(), chunk, chunk + n);
        }
        g_object_unref(body);
    }

    auto *req = WEBKIT_URI_SCHEME_REQUEST(g_object_ref(request));
    pushCoreTask([req, payload = std::move(payload)]() {
        auto response = std::make_shared<std::vector<uint8_t>>(
            Core::callCore(payload));
        runOnMain([req, response]() {
            sendGtkResponse(req, response->data(), response->size(),
                            "application/octet-stream");
            g_object_unref(req);
        });
    });
}

// A small async call: the payload in base64, replied with the response in
// base64, or an empty string when the core put a large response on the frame
// stream
gboolean WebkitGTKWindow::onCallMessage(WebKitUserContentManager *manager,
                                        JSCValue *value,
                                        WebKitScriptMessageReply *reply,
                                        gpointer userData) {
    auto *win = static_cast<WebkitGTKWindow *>(userData);
    char *message = jsc_value_to_string(value);
    std::string decoded = base64_decode(std::string(message ? message : ""));
    g_free(message);
    std::vector<uint8_t> payload(decoded.begin(), decoded.end());

    webkit_script_message_reply_ref(reply);
    auto *context = JSC_CONTEXT(g_object_ref(jsc_value_get_context(value)));
    win->pushCoreTask([reply, context, payload = std::move(payload)]() {
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

void WebkitGTKWindow::handleSchemeRequest(WebKitURISchemeRequest *request) {
    const char *pathC = webkit_uri_scheme_request_get_path(request);
    std::string path = pathC ? pathC : "";
    if (path.empty() || path == "/") {
        path = "/index.html";
    }

    if (path == "/platform") {
        std::string platformStr = "linux";
        sendGtkResponse(request, platformStr.data(), platformStr.size(),
                        "text/plain");
        return;
    }

    if (path == "/ctx") {
        std::string ctxStr = std::to_string(ctx);
        sendGtkResponse(request, ctxStr.data(), ctxStr.size(), "text/plain");
        return;
    }

    if (path == "/stream") {
        startFrameStream(request);
        return;
    }

    if (path == "/stream/detach") {
        // the page did not get the hello frame, it keeps the evaluated chunks
        Core::streamDetach(ctx, 0);
        sendGtkResponse(request, "", 0, "text/plain");
        return;
    }

    if (path == "/bridge") {
        // the page posts its calls to /call and /sync
        std::string binary = "binary";
        sendGtkResponse(request, binary.data(), binary.size(), "text/plain");
        return;
    }

    if (path == "/call" || path == "/sync") {
        handleCall(request);
        return;
    }

    if (path == "/exit") {
        close();
        sendGtkResponse(request, "", 0, "text/plain");
        return;
    }

    if (path.rfind("/resize", 0) == 0) {
        const char *uriC = webkit_uri_scheme_request_get_uri(request);
        std::string uriStr = uriC ? uriC : "";
        size_t queryPos = uriStr.find("size=");
        if (queryPos != std::string::npos) {
            std::string sizeVal = uriStr.substr(queryPos + 5);
            size_t ampPos = sizeVal.find('&');
            if (ampPos != std::string::npos) {
                sizeVal = sizeVal.substr(0, ampPos);
            }
            g_idle_add(
                [](gpointer data) -> gboolean {
                    auto *payload = static_cast<
                        std::pair<WebkitGTKWindow *, std::string> *>(data);
                    payload->first->resize(payload->second);
                    delete payload;
                    return G_SOURCE_REMOVE;
                },
                new std::pair<WebkitGTKWindow *, std::string>(this, sizeVal));
            sendGtkResponse(request, "", 0, "text/plain");
        } else {
            std::string sizeStr = getSize();
            sendGtkResponse(request, sizeStr.data(), sizeStr.size(),
                            "text/plain");
        }
        return;
    }

    if (path.rfind("/open", 0) == 0) {
        const char *uriC = webkit_uri_scheme_request_get_uri(request);
        std::string uriStr = uriC ? uriC : "";
        size_t queryPos = uriStr.find("ctx=");
        if (queryPos != std::string::npos) {
            uint8_t targetCtx =
                static_cast<uint8_t>(std::stoi(uriStr.substr(queryPos + 4)));
            App::instance->open(targetCtx);
        }
        sendGtkResponse(request, "", 0, "text/plain");
        return;
    }

    // Static file serving via Core, read off the main thread, the request is
    // finished on it
    std::vector<uint8_t> header = {ctx,
                                   0, // req id, unused by callWithResponse
                                   0, // Core Module
                                   0, // Fn Static File
                                   0, // Async
                                   static_cast<uint8_t>(STRING)};

    uint8_t pathLen[4];
    numberToUint4Bytes(path.size(), pathLen);

    auto *task = new GtkStaticFileTask();
    task->request = WEBKIT_URI_SCHEME_REQUEST(g_object_ref(request));
    task->payload = header;
    task->payload.insert(task->payload.end(), pathLen, pathLen + 4);
    task->payload.insert(task->payload.end(), path.begin(), path.end());

    static GThreadPool *staticFilePool = g_thread_pool_new(
        runStaticFileTask, nullptr, static_cast<gint>(g_get_num_processors()),
        FALSE, nullptr);
    g_thread_pool_push(staticFilePool, task, nullptr);
}

// runs on the static file pool
void WebkitGTKWindow::runStaticFileTask(gpointer data, gpointer userData) {
    auto *task = static_cast<GtkStaticFileTask *>(data);

    auto responseData = Core::callCore(task->payload);
    task->payload.clear();
    if (responseData.size() > 1) {
        auto [argBuffer, _] = deserialize(responseData, 1);
        std::vector<DataValue> values = deserializeAll(argBuffer.buffer);
        if (values.size() >= 2) {
            task->found = true;
            task->mimeType = values[0].str;
            task->data = std::move(values[1].buffer);
        }
    }

    g_idle_add_full(G_PRIORITY_DEFAULT, dispatchStaticFileResult, task,
                    nullptr);
}

gboolean WebkitGTKWindow::dispatchStaticFileResult(gpointer userData) {
    auto *task = static_cast<GtkStaticFileTask *>(userData);
    if (task->found) {
        sendGtkResponse(task->request, task->data.data(), task->data.size(),
                        task->mimeType);
    } else {
        std::string notFound = "Not Found";
        sendGtkResponse(task->request, notFound.data(), notFound.size(),
                        "text/plain");
    }
    g_object_unref(task->request);
    delete task;
    return G_SOURCE_REMOVE;
}

// called from core threads, App holds the window while it runs
void WebkitGTKWindow::onStreamData(uint8_t streamId,
                                   const std::vector<uint8_t> &data) {
    queueScript("window.fullstacked.onStreamData(" + std::to_string(streamId) +
                ", `" + base64_encode(data.data(), data.size()) + "`)");
}

// any thread, a statement that throws does not stop the others of the batch
void WebkitGTKWindow::queueScript(const std::string &statement) {
    WebKitWebView *view = webview;
    if (!view) return;
    bool schedule = false;
    {
        std::lock_guard<std::mutex> lock(scriptMutex);
        pendingScript += "try{" + statement + "}catch(e){console.error(e)};";
        schedule = !scriptFlushScheduled;
        scriptFlushScheduled = true;
    }
    if (schedule) {
        g_idle_add_full(G_PRIORITY_DEFAULT, flushScripts, g_object_ref(view),
                        nullptr);
    }
}

gboolean WebkitGTKWindow::flushScripts(gpointer userData) {
    auto *view = WEBKIT_WEB_VIEW(userData);
    WebkitGTKWindow *win = fromWebView(view);
    if (win) {
        std::string script;
        {
            std::lock_guard<std::mutex> lock(win->scriptMutex);
            script.swap(win->pendingScript);
            win->scriptFlushScheduled = false;
        }
        if (!script.empty()) {
            webkit_web_view_evaluate_javascript(
                view, script.c_str(), static_cast<gssize>(script.size()),
                nullptr, nullptr, nullptr, nullptr, nullptr);
        }
    }
    g_object_unref(view);
    return G_SOURCE_REMOVE;
}

struct GtkEvalScriptPayload {
        WebKitWebView *webview;
        std::string script;
};

static gboolean dispatchEvalScriptGtk(gpointer userData) {
    auto *payload = static_cast<GtkEvalScriptPayload *>(userData);
    if (payload->webview && WEBKIT_IS_WEB_VIEW(payload->webview)) {
        webkit_web_view_evaluate_javascript(
            payload->webview, payload->script.c_str(),
            static_cast<gssize>(payload->script.size()), nullptr, nullptr,
            nullptr, nullptr, nullptr);
    }
    delete payload;
    return G_SOURCE_REMOVE;
}

void WebkitGTKWindow::evaluateJavaScript(const std::string &script) {
    if (!webview) return;
    auto *payload = new GtkEvalScriptPayload();
    payload->webview = webview;
    payload->script = script;
    g_idle_add(dispatchEvalScriptGtk, payload);
}

void WebkitGTKWindow::bringToFront(bool reload) {
    if (windowGTK) {
        windowGTK->show();
        windowGTK->present();
        if (reload && webview) {
            webkit_web_view_reload(webview);
        }
    } else {
        initWindow();
    }
}

void WebkitGTKWindow::setFullscreen() {
    if (windowGTK) {
        windowGTK->fullscreen();
    }
}

void WebkitGTKWindow::setTitle(const std::string &title) {
    if (windowGTK) {
        windowGTK->set_title(title);
    }
}

std::string WebkitGTKWindow::getSize() {
    if (!windowGTK) return "800:600:0:0";
    if (windowGTK->is_fullscreen()) {
        return "kiosk";
    }
    if (windowGTK->is_maximized()) {
        return "fullscreen";
    }
    int w = windowGTK->get_width();
    int h = windowGTK->get_height();
    return std::to_string(w) + ":" + std::to_string(h) + ":0:0";
}

void WebkitGTKWindow::resize(const std::string &sizeVal) {
    if (!windowGTK) return;
    if (sizeVal == "kiosk") {
        windowGTK->fullscreen();
        return;
    }
    if (sizeVal == "fullscreen") {
        if (windowGTK->is_fullscreen()) {
            windowGTK->unfullscreen();
        }
        windowGTK->maximize();
        return;
    }
    if (windowGTK->is_fullscreen()) {
        windowGTK->unfullscreen();
    }
    if (windowGTK->is_maximized()) {
        windowGTK->unmaximize();
    }
    std::stringstream ss(sizeVal);
    std::string segment;
    std::vector<int> parts;
    while (std::getline(ss, segment, ':')) {
        try {
            parts.push_back(std::stoi(segment));
        } catch (...) {
        }
    }
    if (parts.size() >= 2) {
        int w = parts[0];
        int h = parts[1];
        windowGTK->set_default_size(w, h);
    }
}

void WebkitGTKWindow::close() {
    closeAuthWindow(false);
    if (windowGTK) {
        Gtk::Window *win = windowGTK;
        windowGTK = nullptr;
        // first, so no stream data reaches this window anymore
        App::instance->close(ctx);
        if (webview) {
            g_object_set_data(G_OBJECT(webview), "fullstacked_window", nullptr);
            webview = nullptr;
        }
        if (corePool) {
            // queued calls still run, their results find no window
            g_thread_pool_free(corePool, FALSE, FALSE);
            corePool = nullptr;
        }
        delete win;
    }
}
