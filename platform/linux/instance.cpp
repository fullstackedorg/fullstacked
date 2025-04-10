#include "./instance.h"
#include "./utils.h"
#include <iostream>
#include "./bin/linux-x86_64.h"
#include "./app.h"
#include "gtkmm.h"

std::string notFound = "Not Found";

void Instance::webKitURISchemeRequestCallback(WebKitURISchemeRequest *request, gpointer userData)
{
    Instance *instance = static_cast<Instance *>(userData);

    std::string pathname = webkit_uri_scheme_request_get_path(request);
    std::cout << "PATH: " << pathname << std::endl;

    std::vector<unsigned char> responseData = std::vector<unsigned char>((unsigned char *)notFound.data(), (unsigned char *)notFound.data() + notFound.size());
    std::string responseType = "text/plain";

    if (pathname == "/platform")
    {
        std::string platformStr = "linux";
        responseData = std::vector<unsigned char>((unsigned char *)platformStr.data(), (unsigned char *)platformStr.data() + platformStr.size());
    }
    else if (instance->isEditor && pathname == "/call-sync")
    {
        std::string uri = webkit_uri_scheme_request_get_uri(request);
        int pos = uri.find_last_of("=");
        std::string b64Encoded = uri.substr(pos + 1, uri.npos);
        std::string b64 = uri_decode(uri_decode(b64Encoded));
        unsigned long size;
        guchar *payload = g_base64_decode(b64.data(), &size);
        responseType = "application/octet-stream";
        responseData = instance->callLib((char *)payload, size);
    }
    else
    {
        char *payloadHeader = new char[2];
        payloadHeader[0] = 1; // Static File Serving
        payloadHeader[1] = 2; // STRING

        char *pathnameData = pathname.empty() ? new char[0] : pathname.data();
        int pathnameSize = pathname.size();
        char *pathnameSizeBuffer = numberToByte(pathnameSize);

        char *payloadBody = new char[4 + pathnameSize];
        int payloadBodySize = combineBuffers(
            pathnameSizeBuffer,
            4,
            pathnameData,
            pathnameSize,
            payloadBody);

        char *payload = new char[2 + payloadBodySize];
        int payloadSize = combineBuffers(
            payloadHeader,
            2,
            payloadBody,
            payloadBodySize,
            payload);

        auto libResponse = instance->callLib(payload, payloadSize);
        std::vector<DataValue> values = deserializeArgs(libResponse);

        responseType = values.at(0).str;
        responseData = values.at(1).buffer;
    }

    char *data = new char[responseData.size()];
    memcpy(data, responseData.data(), responseData.size());

    GInputStream *inputStream = g_memory_input_stream_new();
    g_memory_input_stream_add_data(G_MEMORY_INPUT_STREAM(inputStream), data, responseData.size(), [](void *ptr)
                                   { free(ptr); });
    webkit_uri_scheme_request_finish(request, inputStream, responseData.size(), responseType.c_str());
}

void Instance::onScriptMessage(WebKitUserContentManager *manager, JSCValue *value, gpointer userData)
{
    Instance *instance = static_cast<Instance *>(userData);

    if (instance->isEditor && !instance->firstTouch && !App::instance->deeplink.empty())
    {
        std::cout << App::instance->deeplink << std::endl;
        instance->firstTouch = true;
        instance->onMessage(std::string("deeplink").data(), App::instance->deeplink.data());
        App::instance->deeplink = "";
    }

    std::string b64(jsc_value_to_string(value));

    unsigned long size = b64.size();
    guchar *data = g_base64_decode(b64.data(), &size);

    char *reqId = new char[4];
    memcpy(reqId, data, 4);
    size -= 4;

    auto libResponse = instance->callLib(
        reinterpret_cast<char *>(data) + 4,
        size);

    char *responseWithId = new char[libResponse.size() + 4];
    int responseWithIdSize = combineBuffers(
        reqId,
        4,
        reinterpret_cast<char *>(libResponse.data()),
        libResponse.size(),
        responseWithId);

    std::string b64res = g_base64_encode(
        reinterpret_cast<unsigned char *>(responseWithId),
        responseWithIdSize);

    std::string script = "window.respond(`" + b64res + "`);";

    webkit_web_view_evaluate_javascript(
        instance->webview,
        script.data(),
        script.size(),
        nullptr,
        "core",
        nullptr,
        nullptr,
        nullptr);
}

gboolean Instance::navigationDecidePolicy(WebKitWebView *view,
                                          WebKitPolicyDecision *decision,
                                          WebKitPolicyDecisionType decision_type,
                                          gpointer user_data)
{
    WebKitNavigationPolicyDecision *navigation;
    WebKitNavigationAction *action;
    WebKitNavigationType type;
    WebKitURIRequest *request;

    switch (decision_type)
    {
    case WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION:
    case WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION:
        navigation = WEBKIT_NAVIGATION_POLICY_DECISION(decision);
        action = webkit_navigation_policy_decision_get_navigation_action(navigation);
        type = webkit_navigation_action_get_navigation_type(action);

        switch (type)
        {
        case WEBKIT_NAVIGATION_TYPE_LINK_CLICKED:
            request = webkit_navigation_action_get_request(action);
            std::string uri = webkit_uri_request_get_uri(request);

            URL url(uri);

            if (url.host != "localhost")
            {
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

Instance::Instance(std::string pId, bool pIsEditor)
{
    id = pId;
    isEditor = pIsEditor;

    if (isEditor)
    {
        header = new char[5];
        char *isEditorHeader = new char[1];
        isEditorHeader[0] = 1;
        headerSize = combineBuffers(
            isEditorHeader,
            1,
            numberToByte(0),
            4,
            header);
        free(isEditorHeader);
    }
    else
    {
        char *isEditorHeader = new char[1];
        isEditorHeader[0] = 0;

        char *idStrData = id.data();
        int idStrLength = id.size();

        char *intermediateBuffer = new char[1 + 4];
        headerSize = combineBuffers(
            isEditorHeader,
            1,
            numberToByte(idStrLength),
            4,
            intermediateBuffer);
        header = new char[headerSize + idStrLength];
        headerSize = combineBuffers(
            intermediateBuffer,
            headerSize,
            idStrData,
            idStrLength,
            header);

        free(isEditorHeader);
        free(intermediateBuffer);
    }

    set_default_size(800, 600);

    auto webviewGtk = webkit_web_view_new();
    webview = WEBKIT_WEB_VIEW(webviewGtk);
    Gtk::Widget *three = Glib::wrap(GTK_WIDGET(webview));

    std::string scheme = gen_random(6);

    webkit_web_context_register_uri_scheme(
        webkit_web_view_get_context(webview),
        scheme.c_str(),
        Instance::webKitURISchemeRequestCallback,
        this,
        nullptr);

    set_child(*three);
    WebKitSettings *settings = webkit_web_view_get_settings(webview);
    webkit_settings_set_enable_developer_extras(settings, true);
    webkit_web_view_load_uri(webview, (scheme + "://localhost").c_str());

    WebKitUserContentManager *ucm =
        webkit_web_view_get_user_content_manager(webview);
    webkit_user_content_manager_register_script_message_handler(
        ucm,
        "bridge",
        NULL);
    g_signal_connect(ucm, "script-message-received::bridge",
                     G_CALLBACK(Instance::onScriptMessage), this);
    g_signal_connect(webviewGtk, "destroy",
                     G_CALLBACK(App::onClose), this);
    g_signal_connect(webviewGtk, "decide-policy",
                     G_CALLBACK(Instance::navigationDecidePolicy), this);

    auto controller = Gtk::EventControllerKey::create();
    controller->signal_key_pressed().connect(
        sigc::mem_fun(*this, &Instance::on_window_key_pressed), false);
    add_controller(controller);
}

bool Instance::on_window_key_pressed(guint keyval, guint keycode, Gdk::ModifierType state)
{
    // F11
    if(keycode == 95) {
        if(is_fullscreen()) {
            unfullscreen();
        } else {
            fullscreen();
        }
    }
    return true;
}

std::vector<unsigned char> Instance::callLib(char *data, int size)
{
    char *tmpHeader = new char[headerSize];
    memcpy(tmpHeader, header, headerSize);

    char *payload = new char[headerSize + size];
    int payloadSize = combineBuffers(
        tmpHeader,
        headerSize,
        data,
        size,
        payload);

    void *libResponseData = new char[0];

    int libResponseSize = call(payload, payloadSize, &libResponseData);

    std::vector<unsigned char> response((unsigned char *)libResponseData, (unsigned char *)libResponseData + libResponseSize);

    free(tmpHeader);
    free(libResponseData);

    return response;
}

void Instance::onMessage(char *type, char *message)
{
    if (isEditor && std::string(type) == "open")
    {
        App::instance->open(std::string(message), false);
        return;
    }

    std::string script = "window.oncoremessage(`" + std::string(type) + "`, `" + std::string(message) + "`);";

    webkit_web_view_evaluate_javascript(
        webview,
        script.data(),
        script.size(),
        nullptr,
        "core_message",
        nullptr,
        nullptr,
        nullptr);
}