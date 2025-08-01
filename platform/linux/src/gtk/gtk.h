#ifndef WebkitGTKGUI_H_
#define WebkitGTKGUI_H_

#include "../gui.h"
#include <gtkmm/application.h>
#include <string>
#include <webkit/webkit.h>

class WebkitGTKWindow : public Window {
    private:
        Gtk::Window *windowGTK;
        WebKitWebView *webview;
        Glib::RefPtr<Gtk::Application> app;

        static void
        webKitURISchemeRequestCallback(WebKitURISchemeRequest *request,
                                       gpointer userData);
        static void onScriptMessage(WebKitUserContentManager *manager,
                                    JSCValue *value, gpointer userData);
        static gboolean navigationDecidePolicy(
            WebKitWebView *view, WebKitPolicyDecision *decision,
            WebKitPolicyDecisionType decision_type, gpointer user_data);

        void initWindow();

    public:
        WebkitGTKWindow(Glib::RefPtr<Gtk::Application> app);

        void onMessage(std::string type, std::string message);

        void close();

        void bringToFront(bool reload);

        void setFullscreen();

        void setTitle(std::string stitle);
};

class WebkitGTKGUI : public GUI {
    public:
        int run(int &argc, char **argv, std::function<void()> onReady);

        Window *createWindow(std::function<Response(std::string)> onRequest,
                             std::function<std::string(std::string)> onBridge);

    private:
        Glib::RefPtr<Gtk::Application> app;
};

#endif