#include "./qt.h"
#include "../app.h"
#include "../base64.h"
#include "../core.h"
#include "../utils.h"
#include <QBuffer>
#include <QByteArray>
#include <QCloseEvent>
#include <QCoreApplication>
#include <QDesktopServices>
#include <QGuiApplication>
#include <QKeyEvent>
#include <QKeySequence>
#include <QPointer>
#include <QScreen>
#include <QShortcut>
#include <QUrl>
#include <QUrlQuery>
#include <QWebChannel>
#include <QWebEnginePage>
#include <QWebEngineProfile>
#include <QWebEngineScript>
#include <QWebEngineScriptCollection>
#include <QWebEngineSettings>
#include <iostream>
#include <limits>
#include <sstream>
#include <thread>

static void openExternalUrl(const QUrl &url) {
    if (!QDesktopServices::openUrl(url)) {
        std::string cmd =
            "xdg-open '" + url.toString().toStdString() + "' 2>/dev/null &";
        system(cmd.c_str());
    }
}

FrameDevice::FrameDevice(uint8_t pCtx, int pGen, QObject *parent)
    : QIODevice(parent), ctx(pCtx), gen(pGen) {
    // unbuffered: QIODevice keeps no copy of the data on the reading thread
    open(QIODevice::ReadOnly | QIODevice::Unbuffered);
}

FrameDevice::~FrameDevice() {
    // the page went away, stream data goes back to evaluated chunks
    std::lock_guard<std::mutex> lock(mutex);
    if (!ended) {
        Core::streamDetach(ctx, gen);
    }
}

void FrameDevice::start(uint8_t ctx, int gen, FrameDevice *device) {
    QPointer<FrameDevice> target(device);
    std::thread([ctx, gen, target]() {
        while (true) {
            int size = 0;
            void *frames = Core::streamRead(ctx, gen, &size);
            if (frames == nullptr) break;
            QByteArray data(static_cast<const char *>(frames), size);
            Core::freeBuffer(frames);
            QMetaObject::invokeMethod(
                qApp,
                [target, data]() {
                    if (target) target->append(data);
                },
                Qt::QueuedConnection);
        }
        QMetaObject::invokeMethod(
            qApp,
            [target]() {
                if (target) target->finish();
            },
            Qt::QueuedConnection);
    }).detach();
}

qint64 FrameDevice::bytesAvailable() const {
    std::lock_guard<std::mutex> lock(mutex);
    return buffer.size() + QIODevice::bytesAvailable();
}

bool FrameDevice::atEnd() const {
    std::lock_guard<std::mutex> lock(mutex);
    return ended && buffer.isEmpty() && QIODevice::bytesAvailable() == 0;
}

void FrameDevice::append(const QByteArray &frames) {
    {
        std::lock_guard<std::mutex> lock(mutex);
        buffer.append(frames);
    }
    emit readyRead();
}

void FrameDevice::finish() {
    {
        std::lock_guard<std::mutex> lock(mutex);
        ended = true;
    }
    emit readChannelFinished();
}

// called by QtWebEngine on its IO thread
qint64 FrameDevice::readData(char *data, qint64 maxSize) {
    std::lock_guard<std::mutex> lock(mutex);
    if (buffer.isEmpty()) {
        return ended ? -1 : 0;
    }
    qint64 n = qMin(maxSize, static_cast<qint64>(buffer.size()));
    memcpy(data, buffer.constData(), static_cast<size_t>(n));
    buffer.remove(0, static_cast<qsizetype>(n));
    return n;
}

#if QT_VERSION >= QT_VERSION_CHECK(6, 7, 0)
// The body device is handed over closed, and its size and atEnd say
// nothing. Past a first read, a read restarts from the start of the body
// and only ends once the bytes read add up to the body size, so a body read
// in chunks comes back wrong or without end (Qt 6.8). Read all of it at
// once with the size the page sends in X-Body-Size. Empty when missing or
// short.
static QByteArray readRequestBody(QWebEngineUrlRequestJob *job) {
    QIODevice *device = job->requestBody();
    if (!device ||
        (!device->isOpen() && !device->open(QIODevice::ReadOnly))) {
        return {};
    }

    bool ok = false;
    qint64 size = job->requestHeaders().value("X-Body-Size").toLongLong(&ok);
    if (!ok || size <= 0 || size > std::numeric_limits<int>::max()) {
        return {};
    }

    QByteArray body(static_cast<qsizetype>(size), Qt::Uninitialized);
    qint64 read = 0;
    // one read per element of the body, one for an ArrayBuffer
    while (read < size) {
        qint64 n = device->read(body.data() + read, size - read);
        if (n <= 0) return {};
        read += n;
    }
    return body;
}
#endif

// POST /call and /sync: the body is the payload, the response the core
// response; sync is a sync XHR of the page, the same for the host
void QtWindow::handleCall(QWebEngineUrlRequestJob *job) {
#if QT_VERSION >= QT_VERSION_CHECK(6, 7, 0)
    QByteArray body = readRequestBody(job);
    if (body.isEmpty()) {
        job->fail(QWebEngineUrlRequestJob::RequestFailed);
        return;
    }
    QPointer<QWebEngineUrlRequestJob> target(job);
    corePool->start([body, target]() {
        std::vector<uint8_t> payload(body.begin(), body.end());
        auto response = Core::callCore(payload);
        QByteArray data(reinterpret_cast<const char *>(response.data()),
                        static_cast<qsizetype>(response.size()));
        QMetaObject::invokeMethod(
            qApp,
            [target, data]() {
                // the request may be cancelled meanwhile
                if (!target) return;
                auto *buffer = new QBuffer(target);
                buffer->setData(data);
                buffer->open(QIODevice::ReadOnly);
                target->reply("application/octet-stream", buffer);
            },
            Qt::QueuedConnection);
    });
#else
    job->fail(QWebEngineUrlRequestJob::UrlNotFound);
#endif
}

SchemeHandler *SchemeHandler::instance = nullptr;

SchemeHandler::SchemeHandler(QObject *parent)
    : QWebEngineUrlSchemeHandler(parent) {
    SchemeHandler::instance = this;
}

void SchemeHandler::requestStarted(QWebEngineUrlRequestJob *job) {
    QUrl url = job->requestUrl();
    QString host = url.host();
    QtWindow *win = nullptr;

    if (host.startsWith("ctx-")) {
        uint8_t targetCtx = static_cast<uint8_t>(host.mid(4).toUInt());
        if (App::instance) {
            auto it = App::instance->activeWindows.find(targetCtx);
            if (it != App::instance->activeWindows.end()) {
                win = static_cast<QtWindow *>(it->second);
            }
        }
    }

    if (!win && App::instance && !App::instance->activeWindows.empty()) {
        win = static_cast<QtWindow *>(
            App::instance->activeWindows.begin()->second);
    }

    if (win) {
        win->handleSchemeRequest(job);
    } else {
        job->fail(QWebEngineUrlRequestJob::UrlNotFound);
    }
}

void Bridge::postMessage(const QString &message) {
    if (window) {
        window->onBridgeMessage(message.toStdString());
    }
}

QtWebEnginePage::QtWebEnginePage(QWebEngineProfile *profile, QObject *parent,
                                 QtWindow *win)
    : QWebEnginePage(profile, parent), window(win) {
}

QWebEnginePage *QtWebEnginePage::createWindow(WebWindowType type) {
    auto *authWin =
        new AuthWindow(window, window ? window->getQMainWindow() : nullptr);
    authWin->show();
    return authWin->authView->page();
}

bool QtWebEnginePage::acceptNavigationRequest(const QUrl &url,
                                              NavigationType type,
                                              bool isMainFrame) {
    QString scheme = url.scheme();
    QString host = url.host();

    if (scheme == "fs" || host == "localhost" || host == "127.0.0.1" ||
        host.startsWith("ctx-") || scheme == "data" || scheme == "about" ||
        scheme == "blob") {
        return QWebEnginePage::acceptNavigationRequest(url, type, isMainFrame);
    }

    openExternalUrl(url);
    return false;
}

AuthWindow::AuthWindow(QtWindow *pOpener, QWidget *parent)
    : QMainWindow(parent), opener(pOpener), resolved(false), isAuthFlow(false) {
    setWindowTitle("Authentication");
    resize(500, 600);

    if (parent) {
        move(parent->x() + (parent->width() - 500) / 2,
             parent->y() + (parent->height() - 600) / 2);
    }

    authView = new QWebEngineView(this);
    auto *profile = QWebEngineProfile::defaultProfile();
    auto *page = new AuthWebEnginePage(profile, authView, this);

    page->settings()->setAttribute(QWebEngineSettings::JavascriptEnabled, true);
    page->settings()->setAttribute(QWebEngineSettings::LocalStorageEnabled,
                                   true);
    page->settings()->setAttribute(
        QWebEngineSettings::LocalContentCanAccessRemoteUrls, true);
    page->settings()->setAttribute(QWebEngineSettings::WebGLEnabled, true);
    page->settings()->setAttribute(
        QWebEngineSettings::Accelerated2dCanvasEnabled, true);

    // Inject opener polyfill so popup can communicate via postMessage
    QWebEngineScript script;
    QString openerJs =
        "window.opener = {\n"
        "    postMessage: function(data) {\n"
        "        var q = (data && typeof data === 'object') ? "
        "new URLSearchParams(data).toString() : String(data);\n"
        "        location.href = 'fullstacked-auth://auth?' + q;\n"
        "    }\n"
        "};\n";
    script.setSourceCode(openerJs);
    script.setName("auth_opener.js");
    script.setWorldId(QWebEngineScript::MainWorld);
    script.setInjectionPoint(QWebEngineScript::DocumentCreation);
    script.setRunsOnSubFrames(true);
    page->scripts().insert(script);

    QObject::connect(page, &QWebEnginePage::windowCloseRequested,
                     [this]() { close(); });

    authView->setPage(page);
    setCentralWidget(authView);
}

AuthWindow::~AuthWindow() {
    if (!resolved && opener) {
        resolved = true;
        opener->evaluateJavaScript(
            "window.postMessage(new Error(`Authentication Canceled`), \"*\");");
    }
}

void AuthWindow::handleAuthResult(const QString &query) {
    if (resolved) return;
    resolved = true;
    if (opener) {
        QString script = QString("window.postMessage(Object.fromEntries(new "
                                 "URLSearchParams(`%1`)), \"*\");")
                             .arg(query);
        opener->evaluateJavaScript(script.toStdString());
    }
    close();
    deleteLater();
}

void AuthWindow::handleAuthError(const QString &error) {
    if (resolved) return;
    resolved = true;
    if (opener) {
        QString script =
            QString("window.postMessage(new Error(`%1`), \"*\");").arg(error);
        opener->evaluateJavaScript(script.toStdString());
    }
    close();
    deleteLater();
}

void AuthWindow::closeEvent(QCloseEvent *event) {
    if (!resolved && opener) {
        resolved = true;
        opener->evaluateJavaScript(
            "window.postMessage(new Error(`Authentication Canceled`), \"*\");");
    }
    QMainWindow::closeEvent(event);
}

AuthWebEnginePage::AuthWebEnginePage(QWebEngineProfile *profile,
                                     QObject *parent, AuthWindow *win)
    : QWebEnginePage(profile, parent), authWin(win) {
}

bool AuthWebEnginePage::acceptNavigationRequest(const QUrl &url,
                                                NavigationType type,
                                                bool isMainFrame) {
    QString scheme = url.scheme();
    QUrlQuery query(url);

    // Auth results: fullstacked-auth://auth?... fullstacked:// links are
    // deeplinks.
    if (scheme == "fullstacked-auth" || scheme == "fullstacked-ctx" ||
        scheme == "fullstacked-native") {
        if (authWin) {
            authWin->handleAuthResult(url.query());
        }
        return false;
    }
    if (scheme == "fullstacked") {
        App::instance->deepLink(url.toString().toStdString());
        return false;
    }

    if ((url.host() == "localhost" || url.host() == "127.0.0.1") &&
        (query.hasQueryItem("code") || query.hasQueryItem("token") ||
         query.hasQueryItem("access_token"))) {
        if (authWin) {
            authWin->handleAuthResult(url.query());
        }
        return false;
    }

    if (query.hasQueryItem("auth")) {
        if (authWin) authWin->isAuthFlow = true;
        if (!query.hasQueryItem("native")) {
            QUrl nativeUrl = url;
            query.addQueryItem("native", "1");
            // answer on fullstacked-auth://, fullstacked:// carries deeplinks
            query.addQueryItem("callback_scheme", "fullstacked-auth");
            nativeUrl.setQuery(query);
            setUrl(nativeUrl);
            return false;
        }
    } else if (authWin && !authWin->isAuthFlow && scheme != "about" &&
               scheme != "data" && scheme != "blob") {
        openExternalUrl(url);
        authWin->close();
        return false;
    }

    return QWebEnginePage::acceptNavigationRequest(url, type, isMainFrame);
}

int QtGUI::run(int &argc, char **argv, std::function<void()> onReady,
               std::function<void(const std::string &)> onDeepLink) {
    QByteArray existingFlags = qgetenv("QTWEBENGINE_CHROMIUM_FLAGS");
    if (existingFlags.isEmpty()) {
        qputenv("QTWEBENGINE_CHROMIUM_FLAGS", "--no-sandbox "
                                              "--disable-dev-shm-usage "
                                              "--disable-gpu-compositing "
                                              "--ignore-gpu-blocklist "
                                              "--ignore-gpu-blacklist "
                                              "--enable-webgl");
    } else {
        if (!existingFlags.contains("ignore-gpu-blocklist")) {
            existingFlags +=
                " --ignore-gpu-blocklist --ignore-gpu-blacklist --enable-webgl";
            qputenv("QTWEBENGINE_CHROMIUM_FLAGS", existingFlags);
        }
    }

    QCoreApplication::setAttribute(Qt::AA_ShareOpenGLContexts);

    QWebEngineUrlScheme scheme("fs");
    scheme.setSyntax(QWebEngineUrlScheme::Syntax::HostAndPort);
    scheme.setDefaultPort(80);
    QWebEngineUrlScheme::Flags schemeFlags =
        QWebEngineUrlScheme::SecureScheme |
        QWebEngineUrlScheme::LocalAccessAllowed |
        QWebEngineUrlScheme::ViewSourceAllowed |
        QWebEngineUrlScheme::ContentSecurityPolicyIgnored |
        QWebEngineUrlScheme::CorsEnabled;
#if QT_VERSION >= QT_VERSION_CHECK(6, 6, 0)
    // Qt < 6.6 (Ubuntu 24.04 ships 6.4) has no FetchApiAllowed
    schemeFlags |= QWebEngineUrlScheme::FetchApiAllowed;
#endif
    scheme.setFlags(schemeFlags);
    QWebEngineUrlScheme::registerScheme(scheme);

    app = new QApplication(argc, argv);

    // Single instance: a second launch forwards its fullstacked:// deeplinks
    // to the running app over a local socket and exits.
    const QString instanceName = QStringLiteral("org.fullstacked");
    QLocalSocket runningInstance;
    runningInstance.connectToServer(instanceName);
    if (runningInstance.waitForConnected(300)) {
        for (int i = 1; i < argc; i++) {
            std::string arg(argv[i]);
            if (arg.rfind("fullstacked", 0) == 0) {
                runningInstance.write(QByteArray::fromStdString(arg + "\n"));
            }
        }
        runningInstance.flush();
        runningInstance.waitForBytesWritten(1000);
        runningInstance.disconnectFromServer();
        return 0;
    }
    QLocalServer::removeServer(instanceName);
    instanceServer = new QLocalServer(app);
    instanceServer->listen(instanceName);
    QObject::connect(
        instanceServer, &QLocalServer::newConnection, [this, onDeepLink]() {
            QLocalSocket *client = instanceServer->nextPendingConnection();
            QObject::connect(
                client, &QLocalSocket::readyRead, [client, onDeepLink]() {
                    while (client->canReadLine()) {
                        std::string url =
                            client->readLine().trimmed().toStdString();
                        if (!url.empty()) {
                            onDeepLink(url);
                        }
                    }
                });
            QObject::connect(client, &QLocalSocket::disconnected, client,
                             &QObject::deleteLater);
        });

    schemeHandler = new SchemeHandler(app);
    QWebEngineProfile::defaultProfile()->installUrlSchemeHandler("fs",
                                                                 schemeHandler);

    QTimer::singleShot(0, onReady);
    return app->exec();
}

Window *QtGUI::createWindow(uint8_t ctx) {
    return new QtWindow(ctx);
}

QtWindow::QtWindow(uint8_t pCtx) {
    ctx = pCtx;
    init();
}

QtWindow::~QtWindow() {
    close();
}

static const char *s_qwebchannel_js =
    "var QWebChannelMessageTypes = { signal: 1, propertyUpdate: 2, init: 3, "
    "idle: 4, typeDebug: 5, invokeMethod: 6, connectToSignal: 7, "
    "disconnectFromSignal: 8, setProperty: 9, response: 10 };\n"
    "var QWebChannel = function(transport, initCallback) {\n"
    "    if (typeof transport !== 'object' || typeof transport.send !== "
    "'function') {\n"
    "        return;\n"
    "    }\n"
    "    var channel = this;\n"
    "    this.transport = transport;\n"
    "    this.send = function(data) { "
    "channel.transport.send(JSON.stringify(data)); };\n"
    "    this.execCallbacks = {};\n"
    "    this.execId = 0;\n"
    "    this.objects = {};\n"
    "    this.handleSignal = function(message) {\n"
    "        var object = channel.objects[message.object];\n"
    "        if (object) object.signalEmitted(message.signal, message.args);\n"
    "    };\n"
    "    this.handleResponse = function(message) {\n"
    "        if (!message.hasOwnProperty('id')) return;\n"
    "        if (channel.execCallbacks[message.id]) {\n"
    "            channel.execCallbacks[message.id](message.data);\n"
    "            delete channel.execCallbacks[message.id];\n"
    "        }\n"
    "    };\n"
    "    this.handlePropertyUpdate = function(message) {\n"
    "        for (var i in message.data) {\n"
    "            var data = message.data[i];\n"
    "            var object = channel.objects[data.object];\n"
    "            if (object) object.propertyUpdate(data.signals, "
    "data.properties);\n"
    "        }\n"
    "    };\n"
    "    this.transport.onmessage = function(message) {\n"
    "        var data = typeof message.data === 'string' ? "
    "JSON.parse(message.data) : message.data;\n"
    "        switch (data.type) {\n"
    "            case QWebChannelMessageTypes.signal: "
    "channel.handleSignal(data); break;\n"
    "            case QWebChannelMessageTypes.response: "
    "channel.handleResponse(data); break;\n"
    "            case QWebChannelMessageTypes.propertyUpdate: "
    "channel.handlePropertyUpdate(data); break;\n"
    "        }\n"
    "    };\n"
    "    this.exec = function(data, callback) {\n"
    "        var id = ++channel.execId;\n"
    "        data.id = id;\n"
    "        if (callback) {\n"
    "            channel.execCallbacks[id] = callback;\n"
    "        }\n"
    "        channel.send(data);\n"
    "    };\n"
    "    this.exec({ type: QWebChannelMessageTypes.init }, function(data) {\n"
    "        for (var objectName in data) {\n"
    "            var objectInfo = data[objectName];\n"
    "            var object = new QObject(objectName, objectInfo, channel);\n"
    "            channel.objects[objectName] = object;\n"
    "        }\n"
    "        if (initCallback) initCallback(channel);\n"
    "    });\n"
    "};\n"
    "function QObject(name, data, webChannel) {\n"
    "    this.__objectName__ = name;\n"
    "    var self = this;\n"
    "    if (data && data.methods) {\n"
    "        data.methods.forEach(function(method) {\n"
    "            var methodName = method[0];\n"
    "            var methodIdx = method[1];\n"
    "            self[methodName] = function() {\n"
    "                var args = Array.prototype.slice.call(arguments);\n"
    "                var callback;\n"
    "                if (args.length > 0 && typeof args[args.length - 1] === "
    "'function') {\n"
    "                    callback = args.pop();\n"
    "                }\n"
    "                webChannel.exec({\n"
    "                    type: QWebChannelMessageTypes.invokeMethod,\n"
    "                    object: self.__objectName__,\n"
    "                    method: methodIdx,\n"
    "                    args: args\n"
    "                }, callback);\n"
    "            };\n"
    "        });\n"
    "    }\n"
    "}\n"
    "window._pendingBridge = window._pendingBridge || [];\n"
    "window.bridge = window.bridge || {\n"
    "    postMessage: function(msg) {\n"
    "        window._pendingBridge.push(msg);\n"
    "    }\n"
    "};\n"
    "(function initChannel() {\n"
    "    if (typeof qt !== 'undefined' && qt.webChannelTransport) {\n"
    "        new QWebChannel(qt.webChannelTransport, function(channel) {\n"
    "            window.bridge = channel.objects.bridge;\n"
    "            while (window._pendingBridge && window._pendingBridge.length) "
    "{\n"
    "                "
    "window.bridge.postMessage(window._pendingBridge.shift());\n"
    "            }\n"
    "        });\n"
    "    } else {\n"
    "        setTimeout(initChannel, 5);\n"
    "    }\n"
    "})();\n";

class SafeKeyFilter : public QObject {
    public:
        SafeKeyFilter(QObject *parent = nullptr) : QObject(parent) {
        }
        ~SafeKeyFilter() override {
            if (qApp) {
                qApp->removeEventFilter(this);
            }
        }

    protected:
        bool eventFilter(QObject *obj, QEvent *event) override {
            if (event->type() == QEvent::KeyPress ||
                event->type() == QEvent::ShortcutOverride) {
                auto *keyEvent = static_cast<QKeyEvent *>(event);
                if (keyEvent->key() == Qt::Key_T) {
                    auto mods = keyEvent->modifiers();
                    bool isShift = (mods & Qt::ShiftModifier) != 0;
                    bool isCtrlOrMeta =
                        (mods & (Qt::ControlModifier | Qt::MetaModifier)) != 0;
                    if (isShift && isCtrlOrMeta) {
                        if (event->type() == QEvent::ShortcutOverride) {
                            event->accept();
                            return true;
                        }
                        if (App::instance) {
                            App::instance->safeTrigger();
                        }
                        return true;
                    }
                }
            }
            return QObject::eventFilter(obj, event);
        }
};

void QtWindow::init() {
    windowQt = new QMainWindow();
    corePool = new QThreadPool(windowQt);
    corePool->setMaxThreadCount(1);
    windowQt->setWindowTitle("FullStacked");
    windowQt->resize(800, 600);

    auto *shortcutCtrl =
        new QShortcut(QKeySequence(Qt::CTRL | Qt::SHIFT | Qt::Key_T), windowQt);
    shortcutCtrl->setContext(Qt::ApplicationShortcut);
    QObject::connect(shortcutCtrl, &QShortcut::activated, []() {
        if (App::instance) {
            App::instance->safeTrigger();
        }
    });

    auto *shortcutMeta =
        new QShortcut(QKeySequence(Qt::META | Qt::SHIFT | Qt::Key_T), windowQt);
    shortcutMeta->setContext(Qt::ApplicationShortcut);
    QObject::connect(shortcutMeta, &QShortcut::activated, []() {
        if (App::instance) {
            App::instance->safeTrigger();
        }
    });

    auto *keyFilter = new SafeKeyFilter(windowQt);
    windowQt->installEventFilter(keyFilter);
    if (qApp) {
        qApp->installEventFilter(keyFilter);
    }

    webEngineView = new QWebEngineView(windowQt);
    webEngineView->installEventFilter(keyFilter);

    auto *profile = QWebEngineProfile::defaultProfile();

    QWebEngineScript script;
    script.setSourceCode(QString::fromUtf8(s_qwebchannel_js));
    script.setName("qwebchannel.js");
    script.setWorldId(QWebEngineScript::MainWorld);
    script.setInjectionPoint(QWebEngineScript::DocumentCreation);
    script.setRunsOnSubFrames(true);
    profile->scripts()->insert(script);

    auto *page = new QtWebEnginePage(profile, webEngineView, this);
    page->settings()->setAttribute(
        QWebEngineSettings::LocalContentCanAccessRemoteUrls, true);
    page->settings()->setAttribute(
        QWebEngineSettings::LocalContentCanAccessFileUrls, true);
    page->settings()->setAttribute(QWebEngineSettings::LocalStorageEnabled,
                                   true);
    page->settings()->setAttribute(QWebEngineSettings::JavascriptEnabled, true);
    page->settings()->setAttribute(QWebEngineSettings::WebGLEnabled, true);
    page->settings()->setAttribute(
        QWebEngineSettings::Accelerated2dCanvasEnabled, true);
    webEngineView->setPage(page);

    auto *channel = new QWebChannel(page);
    bridge = new Bridge();
    bridge->window = this;
    channel->registerObject("bridge", bridge);
    page->setWebChannel(channel);

    QObject::connect(windowQt, &QMainWindow::destroyed, [this]() { close(); });

    QUrl url = QUrl(QString("fs://ctx-%1/index.html").arg(ctx));
    webEngineView->load(url);

    windowQt->setCentralWidget(webEngineView);
    windowQt->show();
}

void QtWindow::handleSchemeRequest(QWebEngineUrlRequestJob *job) {
    QUrl url = job->requestUrl();
    QString path = url.path();
    if (path.isEmpty() || path == "/") {
        path = "/index.html";
    }

    if (path == "/platform") {
        auto *buffer = new QBuffer();
        buffer->setData("linux");
        buffer->open(QIODevice::ReadOnly);
        job->reply("text/plain", buffer);
        return;
    }

    if (path == "/ctx") {
        auto *buffer = new QBuffer();
        buffer->setData(QByteArray::number(ctx));
        buffer->open(QIODevice::ReadOnly);
        job->reply("text/plain", buffer);
        return;
    }

    if (path == "/stream") {
        int gen = Core::streamAttach(ctx);
        if (gen < 0) {
            job->fail(QWebEngineUrlRequestJob::UrlNotFound);
            return;
        }
        auto *device = new FrameDevice(ctx, gen, job);
        job->reply("application/octet-stream", device);
        FrameDevice::start(ctx, gen, device);
        return;
    }

    if (path == "/stream/detach") {
        // the page did not get the hello frame, it keeps the evaluated chunks
        Core::streamDetach(ctx, 0);
        auto *buffer = new QBuffer(job);
        buffer->open(QIODevice::ReadOnly);
        job->reply("text/plain", buffer);
        return;
    }

    if (path == "/bridge") {
        // Qt >= 6.7 reads request bodies: the page posts its calls to /call
        // and /sync, older Qt keeps the messages over QWebChannel
        auto *buffer = new QBuffer(job);
#if QT_VERSION >= QT_VERSION_CHECK(6, 7, 0)
        buffer->setData("binary");
#else
        buffer->setData("message");
#endif
        buffer->open(QIODevice::ReadOnly);
        job->reply("text/plain", buffer);
        return;
    }

#if QT_VERSION >= QT_VERSION_CHECK(6, 7, 0)
    if (path == "/call" || path == "/sync") {
        handleCall(job);
        return;
    }
#endif

    if (path.startsWith("/sync/")) {
        uint8_t id = static_cast<uint8_t>(path.mid(6).toUInt());
        std::lock_guard<std::mutex> lock(syncMutex);
        auto it = syncAwaitersPayload.find(id);
        if (it != syncAwaitersPayload.end()) {
            auto payload = it->second;
            syncAwaitersPayload.erase(it);
            std::string b64 = base64_encode(payload.data(), payload.size());
            auto *buffer = new QBuffer();
            buffer->setData(
                QByteArray(b64.data(), static_cast<int>(b64.size())));
            buffer->open(QIODevice::ReadOnly);
            job->reply("application/octet-stream", buffer);
        } else {
            syncAwaitersResolve[id] = job;
        }
        return;
    }

    if (path == "/exit") {
        QTimer::singleShot(0, [this]() { close(); });
        auto *buffer = new QBuffer();
        buffer->open(QIODevice::ReadOnly);
        job->reply("text/plain", buffer);
        return;
    }

    if (path == "/resize") {
        QUrlQuery query(url);
        if (query.hasQueryItem("size")) {
            std::string sizeVal = query.queryItemValue("size").toStdString();
            if (windowQt) {
                QMetaObject::invokeMethod(
                    windowQt, [this, sizeVal]() { resize(sizeVal); },
                    Qt::QueuedConnection);
            }
            auto *buffer = new QBuffer();
            buffer->open(QIODevice::ReadOnly);
            job->reply("text/plain", buffer);
        } else {
            std::string sizeStr = getSize();
            auto *buffer = new QBuffer();
            buffer->setData(
                QByteArray(sizeStr.data(), static_cast<int>(sizeStr.size())));
            buffer->open(QIODevice::ReadOnly);
            job->reply("text/plain", buffer);
        }
        return;
    }

    if (path.startsWith("/open")) {
        QUrlQuery query(url);
        if (query.hasQueryItem("ctx")) {
            uint8_t targetCtx =
                static_cast<uint8_t>(query.queryItemValue("ctx").toUInt());
            QTimer::singleShot(
                0, [targetCtx]() { App::instance->open(targetCtx); });
        }
        auto *buffer = new QBuffer();
        buffer->open(QIODevice::ReadOnly);
        job->reply("text/plain", buffer);
        return;
    }

    // Static file serving via Core
    std::string pathStd = path.toStdString();
    std::vector<uint8_t> header = {ctx,
                                   0, // req id, unused by callWithResponse
                                   0, // Core Module
                                   0, // Fn Static File
                                   0, // Async
                                   static_cast<uint8_t>(STRING)};

    uint8_t pathLen[4];
    numberToUint4Bytes(pathStd.size(), pathLen);

    std::vector<uint8_t> payload = header;
    payload.insert(payload.end(), pathLen, pathLen + 4);
    payload.insert(payload.end(), pathStd.begin(), pathStd.end());

    auto responseData = Core::callCore(payload);
    if (responseData.size() <= 1) {
        job->fail(QWebEngineUrlRequestJob::UrlNotFound);
        return;
    }

    auto [argBuffer, _] = deserialize(responseData, 1);
    std::vector<DataValue> values = deserializeAll(argBuffer.buffer);

    if (values.size() < 2) {
        job->fail(QWebEngineUrlRequestJob::UrlNotFound);
        return;
    }

    auto *buffer = new QBuffer();
    buffer->setData(
        QByteArray(reinterpret_cast<const char *>(values[1].buffer.data()),
                   static_cast<int>(values[1].buffer.size())));
    buffer->open(QIODevice::ReadOnly);
    job->reply(QByteArray::fromStdString(values[0].str), buffer);
}

void QtWindow::onBridgeMessage(const std::string &payloadB64) {
    std::string payloadRaw = base64_decode(payloadB64);
    std::vector<uint8_t> payload(payloadRaw.begin(), payloadRaw.end());
    if (payload.empty()) return;

    uint8_t id = payload.size() > 1 ? payload[1] : 0;
    uint8_t isSync = payload.size() > 4 ? payload[4] : 0;

    if (isSync == 1) {
        resolveSyncAwaiter(id, Core::callCore(payload));
    } else {
        // an empty response when the core put a large one on the frame stream
        bool framed = false;
        auto response = Core::callMessage(payload, framed);
        std::string script =
            "if (window.fullstacked && window.fullstacked.respond) { "
            "window.fullstacked.respond(" +
            std::to_string(id) + ", `" +
            base64_encode(response.data(), response.size()) + "`); }";
        if (webEngineView && webEngineView->page()) {
            webEngineView->page()->runJavaScript(
                QString::fromStdString(script));
        }
    }
}

void QtWindow::resolveSyncAwaiter(uint8_t id,
                                  const std::vector<uint8_t> &payload) {
    std::lock_guard<std::mutex> lock(syncMutex);
    auto it = syncAwaitersResolve.find(id);
    if (it != syncAwaitersResolve.end()) {
        QWebEngineUrlRequestJob *job = it->second;
        syncAwaitersResolve.erase(it);
        std::string b64 = base64_encode(payload.data(), payload.size());
        auto *buffer = new QBuffer();
        buffer->setData(QByteArray(b64.data(), static_cast<int>(b64.size())));
        buffer->open(QIODevice::ReadOnly);
        job->reply("application/octet-stream", buffer);
    } else {
        syncAwaitersPayload[id] = payload;
    }
}

// called from core threads, App holds the window while it runs
void QtWindow::onStreamData(uint8_t streamId,
                            const std::vector<uint8_t> &data) {
    QWebEngineView *view = webEngineView;
    if (!view) return;
    // a statement that throws does not stop the others of the batch
    std::string script = "try{window.fullstacked.onStreamData(" +
                         std::to_string(streamId) + ", `" +
                         base64_encode(data.data(), data.size()) +
                         "`)}catch(e){console.error(e)};";
    bool schedule = false;
    {
        std::lock_guard<std::mutex> lock(streamMutex);
        pendingStreamScript += script;
        schedule = !streamFlushScheduled;
        streamFlushScheduled = true;
    }
    if (schedule) {
        // dropped if the view is destroyed before it runs
        QMetaObject::invokeMethod(
            view, [this]() { flushStreamData(); }, Qt::QueuedConnection);
    }
}

void QtWindow::flushStreamData() {
    std::string script;
    {
        std::lock_guard<std::mutex> lock(streamMutex);
        script.swap(pendingStreamScript);
        streamFlushScheduled = false;
    }
    if (script.empty() || !webEngineView || !webEngineView->page()) return;
    webEngineView->page()->runJavaScript(QString::fromStdString(script));
}

void QtWindow::evaluateJavaScript(const std::string &script) {
    if (!webEngineView) return;
    QMetaObject::invokeMethod(
        webEngineView,
        [this, script]() {
            if (webEngineView && webEngineView->page()) {
                webEngineView->page()->runJavaScript(
                    QString::fromStdString(script));
            }
        },
        Qt::QueuedConnection);
}

void QtWindow::bringToFront(bool reload) {
    if (windowQt) {
        windowQt->raise();
        windowQt->show();
        windowQt->activateWindow();
        if (reload && webEngineView) {
            webEngineView->reload();
        }
    }
}

void QtWindow::setFullscreen() {
    if (windowQt) {
        windowQt->setWindowState(Qt::WindowFullScreen);
        windowQt->show();
    }
}

void QtWindow::setTitle(const std::string &title) {
    if (windowQt) {
        windowQt->setWindowTitle(QString::fromStdString(title));
    }
}

std::string QtWindow::getSize() {
    if (!windowQt) return "800:600:0:0";
    if (windowQt->isFullScreen()) {
        return "kiosk";
    }
    if (windowQt->isMaximized()) {
        return "fullscreen";
    }
    int w = windowQt->width();
    int h = windowQt->height();
    int x = windowQt->x();
    int y = windowQt->y();
    return std::to_string(w) + ":" + std::to_string(h) + ":" +
           std::to_string(x) + ":" + std::to_string(y);
}

void QtWindow::resize(const std::string &sizeVal) {
    if (!windowQt) return;
    if (sizeVal == "kiosk") {
        windowQt->showFullScreen();
        return;
    }
    if (sizeVal == "fullscreen") {
        if (windowQt->isFullScreen()) {
            windowQt->showNormal();
        }
        windowQt->showMaximized();
        return;
    }
    if (windowQt->isFullScreen() || windowQt->isMaximized()) {
        windowQt->showNormal();
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
    if (parts.size() == 2) {
        int w = parts[0];
        int h = parts[1];
        int curX = windowQt->x();
        int curY = windowQt->y();
        int curW = windowQt->width();
        int curH = windowQt->height();
        int newX = curX + (curW - w) / 2;
        int newY = curY + (curH - h) / 2;
        windowQt->setGeometry(newX, newY, w, h);
    } else if (parts.size() >= 4) {
        int w = parts[0];
        int h = parts[1];
        int x = parts[2];
        int y = parts[3];
        windowQt->setGeometry(x, y, w, h);
    }
}

void QtWindow::close() {
    if (windowQt) {
        QMainWindow *win = windowQt;
        windowQt = nullptr;
        // first, so no stream data reaches this window anymore
        App::instance->close(ctx);
        webEngineView = nullptr;
        delete win;
    }
}