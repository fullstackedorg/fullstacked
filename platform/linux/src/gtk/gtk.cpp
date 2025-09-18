#include "./gtk.h"
#include "../utils.h"
#include <gobject/gsignal.h>
#include <gtk/gtkwidget.h>
#include <webkit/webkit.h>
#include <iostream>
#include "gtk.h"

Window *
WebkitGTKGUI::createWindow(std::function<Response(std::string)> onRequest,
                           std::function<std::string(std::string)> onBridge) {
    WebkitGTKWindow *window = new WebkitGTKWindow(app);
    window->onRequest = onRequest;
    window->onBridge = onBridge;
    return window;
}

int WebkitGTKGUI::run(int &argc, char **argv, std::function<void()> onReady) {
    app = Gtk::Application::create("org.fullstacked");

    // use this setting to help with memory maangement
    // WebKitMemoryPressureSettings *mp = webkit_memory_pressure_settings_new();
    // webkit_memory_pressure_settings_set_memory_limit(mp, 200);
    // webkit_network_session_set_memory_pressure_settings(mp);

    app->signal_startup().connect(onReady);
    return app->run();
}

WebkitGTKWindow::WebkitGTKWindow(Glib::RefPtr<Gtk::Application> pApp) {
    app = pApp;
    initWindow();
}

void WebkitGTKWindow::webKitURISchemeRequestCallback(
    WebKitURISchemeRequest *request, gpointer userData) {
    WebkitGTKWindow *win = (WebkitGTKWindow *)userData;

    std::string uri = webkit_uri_scheme_request_get_uri(request);
    Response res = win->onRequest(uri);
    char *data = new char[res.data.size()];
    memcpy(data, res.data.data(), res.data.size());
    GInputStream *inputStream =
        g_memory_input_stream_new_from_data(data, res.data.size(), g_free);
    webkit_uri_scheme_request_finish(request, inputStream, res.data.size(),
                                     res.type.c_str());
    g_object_unref(inputStream);
}

void WebkitGTKWindow::onScriptMessage(WebKitUserContentManager *manager,
                                      JSCValue *value, gpointer userData) {
    WebkitGTKWindow *win = (WebkitGTKWindow *)userData;
    std::string payload(jsc_value_to_string(value));
    std::string script = "window.respond(`" + win->onBridge(payload) + "`);";
    webkit_web_view_evaluate_javascript(win->webview, script.data(),
                                        script.size(), nullptr, "bridge",
                                        nullptr, nullptr, nullptr);
}

gboolean WebkitGTKWindow::navigationDecidePolicy(
    WebKitWebView *view, WebKitPolicyDecision *decision,
    WebKitPolicyDecisionType decision_type, gpointer user_data) {
    WebKitNavigationPolicyDecision *navigation;
    WebKitNavigationAction *action;
    WebKitNavigationType type;
    WebKitURIRequest *request;

    switch (decision_type) {
    case WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION:
    case WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION:
        navigation = WEBKIT_NAVIGATION_POLICY_DECISION(decision);
        action =
            webkit_navigation_policy_decision_get_navigation_action(navigation);
        type = webkit_navigation_action_get_navigation_type(action);

        switch (type) {
        case WEBKIT_NAVIGATION_TYPE_LINK_CLICKED:
            request = webkit_navigation_action_get_request(action);
            std::string uri = webkit_uri_request_get_uri(request);

            URL url(uri);

            if (url.host != "localhost") {
                system(("xdg-open " + url.str()).c_str());
                webkit_policy_decision_ignore(decision);
                return false;
            }

            break;
        }
        break;
    default:
        return false;
    }

    return true;
}

void WebkitGTKWindow::initWindow() {
    windowGTK = new Gtk::Window();
    windowGTK->set_title("FullStacked");
    windowGTK->set_default_size(800, 600);
    windowGTK->show();
    windowGTK->signal_close_request().connect(
        [this]() -> bool {
            windowGTK = nullptr;
            return false;
        },
        false);
    app->add_window(*windowGTK);

    auto webviewGtk = webkit_web_view_new();
    webview = WEBKIT_WEB_VIEW(webviewGtk);
    Gtk::Widget *three = Glib::wrap(GTK_WIDGET(webview), false);
    windowGTK->set_child(*three);

    WebKitSettings *settings = webkit_web_view_get_settings(webview);
    webkit_settings_set_enable_developer_extras(settings, true);

    std::string scheme = gen_random(6);

    webkit_web_context_register_uri_scheme(
        webkit_web_view_get_context(webview), scheme.c_str(),
        WebkitGTKWindow::webKitURISchemeRequestCallback, this, nullptr);

    auto ucm = webkit_web_view_get_user_content_manager(webview);
    webkit_user_content_manager_register_script_message_handler(ucm, "bridge",
                                                                NULL);

    g_signal_connect(ucm, "script-message-received::bridge",
                     G_CALLBACK(WebkitGTKWindow::onScriptMessage), this);
    g_signal_connect(webviewGtk, "decide-policy",
                     G_CALLBACK(WebkitGTKWindow::navigationDecidePolicy), this);

    webkit_web_view_load_uri(webview, (scheme + "://localhost").c_str());
}

// source: https://www.studyplan.dev/pro-cpp/std-string/q/replace-all-substrings
std::string replace_all(std::string str, const std::string &from,
                        const std::string &to) {
    size_t start_pos{0};
    while ((start_pos = str.find(from, start_pos)) != std::string::npos) {
        str.replace(start_pos, from.length(), to);

        // In case 'to' contains 'from', like
        // replacing 'x' with 'yx'
        start_pos += to.length();
    }
    return str;
}

void WebkitGTKWindow::onMessage(std::string type, std::string message) {
    message = replace_all(message, "\\", "\\\\");
    message = replace_all(message, "`", "\\`");

    std::string script =
        "window.oncoremessage(`" + type + "`, `" + message + "`);";

    webkit_web_view_evaluate_javascript(webview, script.data(), script.size(),
                                        nullptr, "core_message", nullptr,
                                        nullptr, nullptr);
}

void WebkitGTKWindow::bringToFront(bool reload) {
    if (windowGTK == nullptr) {
        initWindow();
        return;
    }

    windowGTK->show();
    windowGTK->activate();

    if (reload) {
        webkit_web_view_reload(webview);
    }
}

void WebkitGTKWindow::setFullscreen() {
}

void WebkitGTKWindow::close() {
}

void WebkitGTKWindow::setTitle(std::string title) {
    this->windowGTK->set_title(title);
}
