#ifndef Qt_H_
#define Qt_H_

#include "../gui.h"
#include <QApplication>
#include <QLocalServer>
#include <QLocalSocket>
#include <QMainWindow>
#include <QObject>
#include <QTimer>
#include <QWebEnginePage>
#include <QWebEngineProfile>
#include <QWebEngineUrlRequestJob>
#include <QWebEngineUrlScheme>
#include <QWebEngineUrlSchemeHandler>
#include <QWebEngineView>
#include <map>
#include <string>
#include <vector>

class QtBridge;
class QtWindow;
class AuthWindow;

class SchemeHandler : public QWebEngineUrlSchemeHandler {
        Q_OBJECT
    public:
        static SchemeHandler *instance;
        SchemeHandler(QObject *parent = nullptr);
        void requestStarted(QWebEngineUrlRequestJob *job) override;
};

class QtWebEnginePage : public QWebEnginePage {
        Q_OBJECT
    public:
        QtWindow *window = nullptr;
        QtWebEnginePage(QWebEngineProfile *profile, QObject *parent,
                        QtWindow *win);

    protected:
        QWebEnginePage *createWindow(WebWindowType type) override;
        bool acceptNavigationRequest(const QUrl &url, NavigationType type,
                                     bool isMainFrame) override;
};

class AuthWindow : public QMainWindow {
        Q_OBJECT
    public:
        QtWindow *opener = nullptr;
        QWebEngineView *authView = nullptr;
        bool resolved = false;
        bool isAuthFlow = false;

        AuthWindow(QtWindow *pOpener, QWidget *parent = nullptr);
        ~AuthWindow() override;

        void handleAuthResult(const QString &query);
        void handleAuthError(const QString &error);

    protected:
        void closeEvent(QCloseEvent *event) override;
};

class AuthWebEnginePage : public QWebEnginePage {
        Q_OBJECT
    public:
        AuthWindow *authWin = nullptr;
        AuthWebEnginePage(QWebEngineProfile *profile, QObject *parent,
                          AuthWindow *win);

    protected:
        bool acceptNavigationRequest(const QUrl &url, NavigationType type,
                                     bool isMainFrame) override;
};

class QtWindow : public Window {
    private:
        QMainWindow *windowQt = nullptr;
        QWebEngineView *webEngineView = nullptr;
        // calls, stream frames and requests of the page (bridge.cpp),
        // deleted with the page
        QtBridge *bridge = nullptr;

        void init();

    public:
        QtWindow(uint8_t ctx);
        ~QtWindow() override;

        void onStreamData(uint8_t streamId,
                          const std::vector<uint8_t> &data) override;
        void bringToFront(bool reload) override;
        void setFullscreen() override;
        void setTitle(const std::string &title) override;
        void evaluateJavaScript(const std::string &script) override;
        std::string getSize() override;
        void resize(const std::string &size) override;
        void close() override;

        QMainWindow *getQMainWindow() const {
            return windowQt;
        }
        void handleSchemeRequest(QWebEngineUrlRequestJob *job);
};

class QtGUI : public GUI {
    public:
        int run(int &argc, char **argv, std::function<void()> onReady,
                std::function<void(const std::string &)> onDeepLink) override;
        Window *createWindow(uint8_t ctx) override;

    private:
        QApplication *app = nullptr;
        QLocalServer *instanceServer = nullptr;
        SchemeHandler *schemeHandler = nullptr;
};

#endif