#include "./gtk.h"
#include "../app.h"
#include "../base64.h"
#include "../core.h"
#include "../utils.h"
#include <gio/gio.h>
#include <gobject/gsignal.h>
#include <gtk/gtkwidget.h>
#include <iostream>
#include <sstream>

Window *WebkitGTKGUI::createWindow(uint8_t ctx) {
    return new WebkitGTKWindow(ctx, app);
}

int WebkitGTKGUI::run(int &argc, char **argv, std::function<void()> onReady) {
    app = Gtk::Application::create("org.fullstacked");
    WebKitWebContext *context = webkit_web_context_get_default();
    webkit_web_context_register_uri_scheme(context, "fs",
                                           WebkitGTKWindow::webKitURISchemeRequestCallback,
                                           nullptr, nullptr);
    app->signal_startup().connect(onReady);
    return app->run();
}

WebkitGTKWindow::WebkitGTKWindow(uint8_t pCtx, Glib::RefPtr<Gtk::Application> pApp) {
    ctx = pCtx;
    app = pApp;
    initWindow();
}

WebkitGTKWindow::~WebkitGTKWindow() {
    close();
}

static void sendGtkResponse(WebKitURISchemeRequest *request, const void *data, size_t length, const std::string &mimeType) {
    void *copy = g_malloc(length > 0 ? length : 1);
    if (length > 0 && data) {
        memcpy(copy, data, length);
    }
    GInputStream *inputStream = g_memory_input_stream_new_from_data(copy, length, g_free);
    webkit_uri_scheme_request_finish(request, inputStream, length, mimeType.c_str());
    g_object_unref(inputStream);
}

void WebkitGTKWindow::webKitURISchemeRequestCallback(WebKitURISchemeRequest *request, gpointer userData) {
    WebKitWebView *wv = webkit_uri_scheme_request_get_web_view(request);
    WebkitGTKWindow *win = nullptr;
    if (wv) {
        win = static_cast<WebkitGTKWindow *>(g_object_get_data(G_OBJECT(wv), "fullstacked_window"));
    }
    if (!win && App::instance && !App::instance->activeWindows.empty()) {
        win = static_cast<WebkitGTKWindow *>(App::instance->activeWindows.begin()->second);
    }
    if (win) {
        win->handleSchemeRequest(request);
    }
}

void WebkitGTKWindow::onBridgeMessage(WebKitUserContentManager *manager, JSCValue *value, gpointer userData) {
    auto *win = static_cast<WebkitGTKWindow *>(userData);
    char *valStr = jsc_value_to_string(value);
    std::string payload(valStr ? valStr : "");
    g_free(valStr);
    win->handleBridgeMessage(payload);
}

void WebkitGTKWindow::onOpenMessage(WebKitUserContentManager *manager, JSCValue *value, gpointer userData) {
    if (jsc_value_is_number(value)) {
        uint8_t targetCtx = static_cast<uint8_t>(jsc_value_to_int32(value));
        App::instance->open(targetCtx);
    }
}

void WebkitGTKWindow::onExitMessage(WebKitUserContentManager *manager, JSCValue *value, gpointer userData) {
    auto *win = static_cast<WebkitGTKWindow *>(userData);
    win->close();
}

void WebkitGTKWindow::onAuthMessage(WebKitUserContentManager *manager, JSCValue *value, gpointer userData) {
    auto *win = static_cast<WebkitGTKWindow *>(userData);
    char *valStr = jsc_value_to_string(value);
    std::string payload(valStr ? valStr : "");
    g_free(valStr);

    if (!payload.empty()) {
        std::string script = "window.postMessage(Object.fromEntries(new URLSearchParams(`" + payload + "`)), \"*\");";
        win->evaluateJavaScript(script);
        win->authResolved = true;
        win->closeAuthWindow(false);
    }
}

void WebkitGTKWindow::onCloseMessage(WebKitUserContentManager *manager, JSCValue *value, gpointer userData) {
    auto *win = static_cast<WebkitGTKWindow *>(userData);
    win->closeAuthWindow(true);
}

void WebkitGTKWindow::onAuthWebViewClose(WebKitWebView *view, gpointer user_data) {
    auto *win = static_cast<WebkitGTKWindow *>(user_data);
    win->closeAuthWindow(true);
}

gboolean WebkitGTKWindow::navigationDecidePolicy(WebKitWebView *view, WebKitPolicyDecision *decision,
                                                WebKitPolicyDecisionType decision_type, gpointer user_data) {
    if (decision_type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION ||
        decision_type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) {
        auto *navigation = WEBKIT_NAVIGATION_POLICY_DECISION(decision);
        WebKitNavigationAction *action = webkit_navigation_policy_decision_get_navigation_action(navigation);
        WebKitURIRequest *req = webkit_navigation_action_get_request(action);
        const char *uri = webkit_uri_request_get_uri(req);

        if (uri) {
            std::string uriStr(uri);
            if (uriStr.find("localhost") == std::string::npos && uriStr.find("fs://") != 0 &&
                uriStr.find("data:") != 0 && uriStr.find("about:") != 0 && uriStr.find("blob:") != 0) {
                std::string cmd = "xdg-open '" + uriStr + "' 2>/dev/null &";
                system(cmd.c_str());
                webkit_policy_decision_ignore(decision);
                return true;
            }
        }
    }
    return false;
}

GtkWidget *WebkitGTKWindow::onCreateWebView(WebKitWebView *view, WebKitNavigationAction *navigation_action, gpointer user_data) {
    auto *win = static_cast<WebkitGTKWindow *>(user_data);
    return win->createAuthWebView(navigation_action);
}

GtkWidget *WebkitGTKWindow::createAuthWebView(WebKitNavigationAction *navigation_action) {
    WebKitURIRequest *req = navigation_action ? webkit_navigation_action_get_request(navigation_action) : nullptr;
    const char *uri = req ? webkit_uri_request_get_uri(req) : nullptr;
    std::string uriStr = uri ? uri : "";

    if (!uriStr.empty() && uriStr.find("auth") == std::string::npos &&
        uriStr.find("localhost") == std::string::npos && uriStr.find("fs://") != 0) {
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

    GtkWidget *authWebviewWidget = GTK_WIDGET(g_object_new(WEBKIT_TYPE_WEB_VIEW, "related-view", webview, NULL));
    WebKitWebView *authWebview = WEBKIT_WEB_VIEW(authWebviewWidget);

    WebKitWindowProperties *props = webkit_web_view_get_window_properties(authWebview);
    if (props) {
        GdkRectangle geometry;
        webkit_window_properties_get_geometry(props, &geometry);
        if (geometry.width > 0 && geometry.height > 0) {
            authWindowGTK->set_default_size(geometry.width, geometry.height);
        }
    }

    WebKitSettings *settings = webkit_web_view_get_settings(authWebview);
    webkit_settings_set_enable_developer_extras(settings, true);
    webkit_settings_set_javascript_can_open_windows_automatically(settings, true);

    WebKitUserContentManager *ucm = webkit_web_view_get_user_content_manager(authWebview);
    webkit_user_content_manager_register_script_message_handler(ucm, "auth", NULL);
    webkit_user_content_manager_register_script_message_handler(ucm, "close", NULL);
    g_signal_connect(ucm, "script-message-received::auth", G_CALLBACK(WebkitGTKWindow::onAuthMessage), this);
    g_signal_connect(ucm, "script-message-received::close", G_CALLBACK(WebkitGTKWindow::onCloseMessage), this);

    WebKitUserScript *userScript = webkit_user_script_new(
        "window.opener = {\n"
        "    postMessage: function(data) {\n"
        "        var q = (data && typeof data === 'object') ? new URLSearchParams(data).toString() : String(data);\n"
        "        if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.auth) {\n"
        "            window.webkit.messageHandlers.auth.postMessage(q);\n"
        "        } else {\n"
        "            location.href = 'fullstacked://auth?' + q;\n"
        "        }\n"
        "    }\n"
        "};\n"
        "var origClose = window.close;\n"
        "window.close = function() {\n"
        "    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.close) {\n"
        "        window.webkit.messageHandlers.close.postMessage('');\n"
        "    } else if (origClose) {\n"
        "        origClose.apply(window, arguments);\n"
        "    }\n"
        "};\n",
        WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES,
        WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START,
        nullptr, nullptr
    );
    webkit_user_content_manager_add_script(ucm, userScript);
    webkit_user_script_unref(userScript);

    g_signal_connect(authWebviewWidget, "decide-policy", G_CALLBACK(WebkitGTKWindow::authNavigationDecidePolicy), this);
    g_signal_connect(authWebviewWidget, "load-changed", G_CALLBACK(WebkitGTKWindow::onAuthLoadChanged), this);
    g_signal_connect(authWebviewWidget, "load-failed", G_CALLBACK(WebkitGTKWindow::onAuthLoadFailed), this);
    g_signal_connect(authWebviewWidget, "close", G_CALLBACK(WebkitGTKWindow::onAuthWebViewClose), this);

    Gtk::Widget *widget = Glib::wrap(authWebviewWidget, false);
    authWindowGTK->set_child(*widget);
    app->add_window(*authWindowGTK);

    authWindowGTK->signal_close_request().connect([this]() -> bool {
        closeAuthWindow(true);
        return false;
    }, false);

    authWindowGTK->show();
    return authWebviewWidget;
}

bool WebkitGTKWindow::checkAuthUri(const std::string &u) {
    if (u.rfind("fullstacked://", 0) == 0 || u.rfind("fullstacked-auth://", 0) == 0 || u.rfind("fullstacked-ctx://", 0) == 0) {
        size_t qPos = u.find('?');
        std::string query = (qPos != std::string::npos) ? u.substr(qPos + 1) : "";
        std::string script = "window.postMessage(Object.fromEntries(new URLSearchParams(`" + query + "`)), \"*\");";
        evaluateJavaScript(script);
        authResolved = true;
        closeAuthWindow(false);
        return true;
    }
    if ((u.find("localhost") != std::string::npos || u.find("127.0.0.1") != std::string::npos) &&
        (u.find("code=") != std::string::npos || u.find("token=") != std::string::npos || u.find("access_token=") != std::string::npos)) {
        size_t qPos = u.find('?');
        std::string query = (qPos != std::string::npos) ? u.substr(qPos + 1) : "";
        std::string script = "window.postMessage(Object.fromEntries(new URLSearchParams(`" + query + "`)), \"*\");";
        evaluateJavaScript(script);
        authResolved = true;
        closeAuthWindow(false);
        return true;
    }
    return false;
}

gboolean WebkitGTKWindow::authNavigationDecidePolicy(WebKitWebView *view, WebKitPolicyDecision *decision,
                                                    WebKitPolicyDecisionType decision_type, gpointer user_data) {
    auto *win = static_cast<WebkitGTKWindow *>(user_data);
    if (decision_type == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION ||
        decision_type == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) {
        auto *navigation = WEBKIT_NAVIGATION_POLICY_DECISION(decision);
        WebKitNavigationAction *action = webkit_navigation_policy_decision_get_navigation_action(navigation);
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

void WebkitGTKWindow::onAuthLoadChanged(WebKitWebView *view, WebKitLoadEvent load_event, gpointer user_data) {
    auto *win = static_cast<WebkitGTKWindow *>(user_data);
    const char *uri = webkit_web_view_get_uri(view);
    if (uri) {
        win->checkAuthUri(std::string(uri));
    }
}

gboolean WebkitGTKWindow::onAuthLoadFailed(WebKitWebView *view, WebKitLoadEvent load_event, const char *failing_uri, GError *error, gpointer user_data) {
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
            evaluateJavaScript("window.postMessage(new Error(`Authentication Canceled`), \"*\");");
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
    windowGTK->signal_close_request().connect([this]() -> bool {
        close();
        return false;
    }, false);
    app->add_window(*windowGTK);

    GtkWidget *webviewWidget = webkit_web_view_new();
    webview = WEBKIT_WEB_VIEW(webviewWidget);
    g_object_set_data(G_OBJECT(webview), "fullstacked_window", this);

    Gtk::Widget *widget = Glib::wrap(webviewWidget, false);
    windowGTK->set_child(*widget);

    WebKitSettings *settings = webkit_web_view_get_settings(webview);
    webkit_settings_set_enable_developer_extras(settings, true);
    webkit_settings_set_javascript_can_open_windows_automatically(settings, true);

    WebKitUserContentManager *ucm = webkit_web_view_get_user_content_manager(webview);
    webkit_user_content_manager_register_script_message_handler(ucm, "bridge", NULL);
    webkit_user_content_manager_register_script_message_handler(ucm, "open", NULL);
    webkit_user_content_manager_register_script_message_handler(ucm, "exit", NULL);

    g_signal_connect(ucm, "script-message-received::bridge", G_CALLBACK(WebkitGTKWindow::onBridgeMessage), this);
    g_signal_connect(ucm, "script-message-received::open", G_CALLBACK(WebkitGTKWindow::onOpenMessage), this);
    g_signal_connect(ucm, "script-message-received::exit", G_CALLBACK(WebkitGTKWindow::onExitMessage), this);
    g_signal_connect(webviewWidget, "decide-policy", G_CALLBACK(WebkitGTKWindow::navigationDecidePolicy), this);
    g_signal_connect(webviewWidget, "create", G_CALLBACK(WebkitGTKWindow::onCreateWebView), this);

    webkit_web_view_load_uri(webview, "fs://localhost");
}

void WebkitGTKWindow::handleBridgeMessage(const std::string &payloadB64) {
    std::string payloadRaw = base64_decode(payloadB64);
    std::vector<uint8_t> payload(payloadRaw.begin(), payloadRaw.end());
    if (payload.empty()) return;

    auto response = Core::callCore(payload);
    uint8_t id = payload.size() > 1 ? payload[1] : 0;
    uint8_t isSync = payload.size() > 4 ? payload[4] : 0;

    if (isSync == 1) {
        resolveSyncAwaiter(id, response);
    } else {
        std::string respB64 = base64_encode(response.data(), response.size());
        std::string script = "if (window.fullstacked && window.fullstacked.respond) { window.fullstacked.respond(" +
                             std::to_string(id) + ", `" + respB64 + "`); }";
        webkit_web_view_evaluate_javascript(webview, script.c_str(), static_cast<gssize>(script.size()), nullptr, nullptr, nullptr, nullptr, nullptr);
    }
}

void WebkitGTKWindow::resolveSyncAwaiter(uint8_t id, const std::vector<uint8_t> &payload) {
    std::lock_guard<std::mutex> lock(syncMutex);
    auto it = syncAwaitersResolve.find(id);
    if (it != syncAwaitersResolve.end()) {
        WebKitURISchemeRequest *req = it->second;
        syncAwaitersResolve.erase(it);
        std::string b64 = base64_encode(payload.data(), payload.size());
        sendGtkResponse(req, b64.data(), b64.size(), "application/octet-stream");
        g_object_unref(req);
    } else {
        syncAwaitersPayload[id] = payload;
    }
}

void WebkitGTKWindow::handleSchemeRequest(WebKitURISchemeRequest *request) {
    const char *pathC = webkit_uri_scheme_request_get_path(request);
    std::string path = pathC ? pathC : "";
    if (path.empty() || path == "/") {
        path = "/index.html";
    }

    if (path == "/platform") {
        std::string platformStr = "linux";
        sendGtkResponse(request, platformStr.data(), platformStr.size(), "text/plain");
        return;
    }

    if (path == "/ctx") {
        std::string ctxStr = std::to_string(ctx);
        sendGtkResponse(request, ctxStr.data(), ctxStr.size(), "text/plain");
        return;
    }

    if (path.rfind("/sync/", 0) == 0) {
        std::string idStr = path.substr(6);
        uint8_t id = static_cast<uint8_t>(std::stoi(idStr));

        std::lock_guard<std::mutex> lock(syncMutex);
        auto it = syncAwaitersPayload.find(id);
        if (it != syncAwaitersPayload.end()) {
            auto payload = it->second;
            syncAwaitersPayload.erase(it);
            std::string b64 = base64_encode(payload.data(), payload.size());
            sendGtkResponse(request, b64.data(), b64.size(), "application/octet-stream");
        } else {
            g_object_ref(request);
            syncAwaitersResolve[id] = request;
        }
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
            g_idle_add([](gpointer data) -> gboolean {
                auto *payload = static_cast<std::pair<WebkitGTKWindow*, std::string>*>(data);
                payload->first->resize(payload->second);
                delete payload;
                return G_SOURCE_REMOVE;
            }, new std::pair<WebkitGTKWindow*, std::string>(this, sizeVal));
            sendGtkResponse(request, "", 0, "text/plain");
        } else {
            std::string sizeStr = getSize();
            sendGtkResponse(request, sizeStr.data(), sizeStr.size(), "text/plain");
        }
        return;
    }

    if (path.rfind("/open", 0) == 0) {
        const char *uriC = webkit_uri_scheme_request_get_uri(request);
        std::string uriStr = uriC ? uriC : "";
        size_t queryPos = uriStr.find("ctx=");
        if (queryPos != std::string::npos) {
            uint8_t targetCtx = static_cast<uint8_t>(std::stoi(uriStr.substr(queryPos + 4)));
            App::instance->open(targetCtx);
        }
        sendGtkResponse(request, "", 0, "text/plain");
        return;
    }

    // Static file serving via Core
    std::vector<uint8_t> header = {
        ctx,
        0, // req id
        0, // Core Module
        0, // Fn Static File
        0, // Async
        static_cast<uint8_t>(STRING)
    };

    uint8_t pathLen[4];
    numberToUint4Bytes(path.size(), pathLen);

    std::vector<uint8_t> payload = header;
    payload.insert(payload.end(), pathLen, pathLen + 4);
    payload.insert(payload.end(), path.begin(), path.end());

    auto responseData = Core::callCore(payload);
    if (responseData.size() <= 1) {
        std::string notFound = "Not Found";
        sendGtkResponse(request, notFound.data(), notFound.size(), "text/plain");
        return;
    }

    auto [argBuffer, _] = deserialize(responseData, 1);
    std::vector<DataValue> values = deserializeAll(argBuffer.buffer);

    if (values.size() < 2) {
        std::string notFound = "Not Found";
        sendGtkResponse(request, notFound.data(), notFound.size(), "text/plain");
        return;
    }

    sendGtkResponse(request, values[1].buffer.data(), values[1].buffer.size(), values[0].str);
}

struct GtkStreamDataPayload {
    WebKitWebView *webview;
    uint8_t streamId;
    std::string b64;
};

static gboolean dispatchStreamDataGtk(gpointer userData) {
    auto *payload = static_cast<GtkStreamDataPayload *>(userData);
    if (payload->webview && WEBKIT_IS_WEB_VIEW(payload->webview)) {
        std::string script = "if (window.fullstacked && window.fullstacked.onStreamData) { window.fullstacked.onStreamData(" +
                             std::to_string(payload->streamId) + ", `" + payload->b64 + "`); }";
        webkit_web_view_evaluate_javascript(payload->webview, script.c_str(), static_cast<gssize>(script.size()), nullptr, nullptr, nullptr, nullptr, nullptr);
    }
    delete payload;
    return G_SOURCE_REMOVE;
}

void WebkitGTKWindow::onStreamData(uint8_t streamId, const std::vector<uint8_t> &data) {
    if (!webview) return;
    auto *payload = new GtkStreamDataPayload();
    payload->webview = webview;
    payload->streamId = streamId;
    payload->b64 = base64_encode(data.data(), data.size());
    g_idle_add(dispatchStreamDataGtk, payload);
}

struct GtkEvalScriptPayload {
    WebKitWebView *webview;
    std::string script;
};

static gboolean dispatchEvalScriptGtk(gpointer userData) {
    auto *payload = static_cast<GtkEvalScriptPayload *>(userData);
    if (payload->webview && WEBKIT_IS_WEB_VIEW(payload->webview)) {
        webkit_web_view_evaluate_javascript(payload->webview, payload->script.c_str(), static_cast<gssize>(payload->script.size()), nullptr, nullptr, nullptr, nullptr, nullptr);
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
        } catch (...) {}
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
        if (webview) {
            g_object_set_data(G_OBJECT(webview), "fullstacked_window", nullptr);
            webview = nullptr;
        }
        App::instance->close(ctx);
        delete win;
    }
}
