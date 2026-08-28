#ifndef Qt_H_
#define Qt_H_

#include "../gui.h"
#include <QApplication>
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
#include <mutex>
#include <string>
#include <vector>

class Bridge;
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
    QtWebEnginePage(QWebEngineProfile *profile, QObject *parent, QtWindow *win);

protected:
    QWebEnginePage *createWindow(WebWindowType type) override;
    bool acceptNavigationRequest(const QUrl &url, NavigationType type, bool isMainFrame) override;
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
    AuthWebEnginePage(QWebEngineProfile *profile, QObject *parent, AuthWindow *win);

protected:
    bool acceptNavigationRequest(const QUrl &url, NavigationType type, bool isMainFrame) override;
};

class QtWindow : public Window {
private:
    QMainWindow *windowQt = nullptr;
    QWebEngineView *webEngineView = nullptr;
    Bridge *bridge = nullptr;

    std::mutex syncMutex;
    std::map<uint8_t, QWebEngineUrlRequestJob *> syncAwaitersResolve;
    std::map<uint8_t, std::vector<uint8_t>> syncAwaitersPayload;

    void init();

public:
    QtWindow(uint8_t ctx);
    ~QtWindow() override;

    void onStreamData(uint8_t streamId, const std::vector<uint8_t> &data) override;
    void bringToFront(bool reload) override;
    void setFullscreen() override;
    void setTitle(const std::string &title) override;
    void evaluateJavaScript(const std::string &script) override;
    std::string getSize() override;
    void resize(const std::string &size) override;
    void close() override;

    QMainWindow *getQMainWindow() const { return windowQt; }
    void onBridgeMessage(const std::string &payloadB64);
    void resolveSyncAwaiter(uint8_t id, const std::vector<uint8_t> &payload);
    void handleSchemeRequest(QWebEngineUrlRequestJob *job);
};

class Bridge : public QObject {
    Q_OBJECT
public:
    QtWindow *window = nullptr;

public slots:
    void postMessage(const QString &message);
};

class QtGUI : public GUI {
public:
    int run(int &argc, char **argv, std::function<void()> onReady) override;
    Window *createWindow(uint8_t ctx) override;

private:
    QApplication *app = nullptr;
    SchemeHandler *schemeHandler = nullptr;
};

#endif