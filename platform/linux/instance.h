#ifndef INSTANCE_H_
#define INSTANCE_H_

#include <gtkmm/application.h>
#include <webkit/webkit.h>

class Instance : public Gtk::Window
{
private:
    bool isEditor;
    char *header;
    int headerSize;
    bool firstTouch;

public:
    std::string id;
    WebKitWebView *webview;

    static void webKitURISchemeRequestCallback(WebKitURISchemeRequest *request, gpointer userData);

    static void onScriptMessage(WebKitUserContentManager *manager, JSCValue *value, gpointer userData);

    static gboolean navigationDecidePolicy(WebKitWebView *view,
        WebKitPolicyDecision *decision,
        WebKitPolicyDecisionType decision_type,
        gpointer user_data);

    bool on_window_key_pressed(guint keyval, guint keycode, Gdk::ModifierType state);

    Instance(std::string pId, bool pIsEditor);

    std::vector<unsigned char> callLib(char *data, int size);

    void onMessage(char* type, char* message);
};

#endif