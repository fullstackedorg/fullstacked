#ifndef WebkitGTKGUI_H_
#define WebkitGTKGUI_H_

#include "../gui.h"
#include <gtkmm/application.h>
#include <gtkmm/window.h>
#include <map>
#include <mutex>
#include <string>
#include <vector>
#include <webkit/webkit.h>

class WebkitGTKWindow : public Window {
        friend class WebkitGTKGUI;

    private:
        Gtk::Window *windowGTK = nullptr;
        WebKitWebView *webview = nullptr;
        Glib::RefPtr<Gtk::Application> app;

        Gtk::Window *authWindowGTK = nullptr;
        bool authResolved = false;

        // core calls of this window run in order, off the main thread
        GThreadPool *corePool = nullptr;

        // responses and stream chunks received between two main loop
        // iterations are evaluated in one script
        std::mutex scriptMutex;
        std::string pendingScript;
        bool scriptFlushScheduled = false;
        void queueScript(const std::string &statement);

        // results of work done off the main thread come back through the
        // webview (ref'd), the window is looked up from it once on the main
        // thread since it may have closed in between
        static WebkitGTKWindow *fromWebView(WebKitWebView *view);
        // core pool and main loop tasks are std::function<void()>
        static void runCoreTask(gpointer data, gpointer userData);
        static gboolean runMainTask(gpointer data);
        void pushCoreTask(std::function<void()> task);
        static void runOnMain(std::function<void()> task);
        static gboolean onCallMessage(WebKitUserContentManager *manager,
                                      JSCValue *value,
                                      WebKitScriptMessageReply *reply,
                                      gpointer userData);
        static void runStaticFileTask(gpointer data, gpointer userData);
        static gboolean dispatchStaticFileResult(gpointer userData);
        static gboolean flushScripts(gpointer userData);

        static void onOpenMessage(WebKitUserContentManager *manager,
                                  JSCValue *value, gpointer userData);
        static void onExitMessage(WebKitUserContentManager *manager,
                                  JSCValue *value, gpointer userData);
        static void onAuthMessage(WebKitUserContentManager *manager,
                                  JSCValue *value, gpointer userData);
        static void onCloseMessage(WebKitUserContentManager *manager,
                                   JSCValue *value, gpointer userData);
        static gboolean navigationDecidePolicy(
            WebKitWebView *view, WebKitPolicyDecision *decision,
            WebKitPolicyDecisionType decision_type, gpointer user_data);
        static GtkWidget *
        onCreateWebView(WebKitWebView *view,
                        WebKitNavigationAction *navigation_action,
                        gpointer user_data);
        static gboolean authNavigationDecidePolicy(
            WebKitWebView *view, WebKitPolicyDecision *decision,
            WebKitPolicyDecisionType decision_type, gpointer user_data);
        static void onAuthLoadChanged(WebKitWebView *view,
                                      WebKitLoadEvent load_event,
                                      gpointer user_data);
        static gboolean onAuthLoadFailed(WebKitWebView *view,
                                         WebKitLoadEvent load_event,
                                         const char *failing_uri, GError *error,
                                         gpointer user_data);
        static void onAuthWebViewClose(WebKitWebView *view, gpointer user_data);

        void initWindow();
        void handleSchemeRequest(WebKitURISchemeRequest *request);
        void startFrameStream(WebKitURISchemeRequest *request);
        void handleCall(WebKitURISchemeRequest *request);

        GtkWidget *createAuthWebView(WebKitNavigationAction *navigation_action);
        void closeAuthWindow(bool canceled = false);
        bool checkAuthUri(const std::string &uri);

    public:
        static void
        webKitURISchemeRequestCallback(WebKitURISchemeRequest *request,
                                       gpointer userData);

        WebkitGTKWindow(uint8_t ctx, Glib::RefPtr<Gtk::Application> app);
        ~WebkitGTKWindow() override;

        void onStreamData(uint8_t streamId,
                          const std::vector<uint8_t> &data) override;
        void bringToFront(bool reload) override;
        void setFullscreen() override;
        void setTitle(const std::string &title) override;
        void evaluateJavaScript(const std::string &script) override;
        std::string getSize() override;
        void resize(const std::string &size) override;
        void close() override;
};

class WebkitGTKGUI : public GUI {
    public:
        int run(int &argc, char **argv, std::function<void()> onReady,
                std::function<void(const std::string &)> onDeepLink) override;
        Window *createWindow(uint8_t ctx) override;

    private:
        Glib::RefPtr<Gtk::Application> app;
};

#endif