#include "./bridge.h"
#include "../base64.h"
#include "../core.h"
#include <QBuffer>
#include <QCoreApplication>
#include <QPointer>
#include <QWebChannel>
#include <limits>
#include <thread>

const bool QtBridge::binaryCalls = QT_VERSION >= QT_VERSION_CHECK(6, 7, 0);

QtBridge::QtBridge(uint8_t pCtx, QWebEnginePage *pPage)
    : QObject(pPage), ctx(pCtx), page(pPage) {
    corePool = new QThreadPool(this);
    corePool->setMaxThreadCount(1);
    auto *channel = new QWebChannel(page);
    channel->registerObject("bridge", this);
    page->setWebChannel(channel);
}

static void reply(QWebEngineUrlRequestJob *job, const QByteArray &mimeType,
                  const char *data, qsizetype size) {
    auto *buffer = new QBuffer(job);
    buffer->setData(data, size);
    buffer->open(QIODevice::ReadOnly);
    job->reply(mimeType, buffer);
}

static void reply(QWebEngineUrlRequestJob *job,
                  const Core::Response &response) {
    if (response.status != 200) {
        job->fail(QWebEngineUrlRequestJob::UrlNotFound);
        return;
    }
    reply(job, QByteArray::fromStdString(response.mimeType),
          reinterpret_cast<const char *>(response.data.data()),
          static_cast<qsizetype>(response.data.size()));
}

#if QT_VERSION >= QT_VERSION_CHECK(6, 7, 0)
// The body device is handed over closed, and its size and atEnd say
// nothing. Past a first read, a read restarts from the start of the body
// and only ends once the bytes read add up to the body size, so a body read
// in chunks comes back wrong or without end (Qt 6.8). Read all of it at
// once with the size the page sends in X-Body-Size. Empty when missing or
// short.
static std::vector<uint8_t> readRequestBody(QWebEngineUrlRequestJob *job) {
    QIODevice *device = job->requestBody();
    if (!device || (!device->isOpen() && !device->open(QIODevice::ReadOnly))) {
        return {};
    }
    bool ok = false;
    qint64 size = job->requestHeaders().value("X-Body-Size").toLongLong(&ok);
    if (!ok || size <= 0 || size > std::numeric_limits<int>::max()) {
        return {};
    }
    std::vector<uint8_t> body(static_cast<size_t>(size));
    qint64 read = 0;
    // one read per element of the body, one for an ArrayBuffer
    while (read < size) {
        qint64 n = device->read(reinterpret_cast<char *>(body.data()) + read,
                                size - read);
        if (n <= 0) return {};
        read += n;
    }
    return body;
}
#endif

void QtBridge::request(QWebEngineUrlRequestJob *job, const QString &path) {
    if (path == "/stream") {
        startFrameStream(job);
    } else if (path.startsWith("/sync/")) {
        uint8_t id = static_cast<uint8_t>(path.mid(6).toUInt());
        auto it = syncResponses.find(id);
        if (it == syncResponses.end()) {
            syncJobs[id] = job;
            return;
        }
        std::string b64 = base64_encode(it->second.data(), it->second.size());
        syncResponses.erase(it);
        reply(job, "application/octet-stream", b64.data(),
              static_cast<qsizetype>(b64.size()));
    } else if (path == "/call" || path == "/sync") {
#if QT_VERSION >= QT_VERSION_CHECK(6, 7, 0)
        std::vector<uint8_t> body = readRequestBody(job);
        if (body.empty()) {
            job->fail(QWebEngineUrlRequestJob::RequestFailed);
            return;
        }
        QPointer<QWebEngineUrlRequestJob> target(job);
        corePool->start([ctx = ctx, path = path.toStdString(),
                         body = std::move(body), target]() {
            auto response = Core::request(ctx, path, body);
            QMetaObject::invokeMethod(
                qApp,
                [target, response = std::move(response)]() {
                    // the request may be cancelled meanwhile
                    if (target) reply(target, response);
                },
                Qt::QueuedConnection);
        });
#else
        job->fail(QWebEngineUrlRequestJob::UrlNotFound);
#endif
    } else {
        reply(job, Core::request(ctx, path.toStdString(), {}));
    }
}

QString QtBridge::postMessage(const QString &message) {
    std::string decoded = base64_decode(message.toStdString());
    std::vector<uint8_t> payload(decoded.begin(), decoded.end());
    if (payload.size() < 5) return "";
    if (payload[4] == 1) {
        resolveSync(payload[1], Core::callCore(payload));
        return "";
    }
    bool framed = false;
    auto response = Core::callMessage(payload, framed);
    if (framed) return "";
    return QString::fromStdString(
        base64_encode(response.data(), response.size()));
}

void QtBridge::resolveSync(uint8_t id, const std::vector<uint8_t> &response) {
    auto it = syncJobs.find(id);
    if (it == syncJobs.end()) {
        syncResponses[id] = response;
        return;
    }
    std::string b64 = base64_encode(response.data(), response.size());
    reply(it->second, "application/octet-stream", b64.data(),
          static_cast<qsizetype>(b64.size()));
    syncJobs.erase(it);
}

// any thread, a statement that throws does not stop the others of the batch
void QtBridge::onStreamData(uint8_t streamId,
                            const std::vector<uint8_t> &data) {
    {
        std::lock_guard<std::mutex> lock(scriptMutex);
        pendingScript += "try{window.fullstacked.onStreamData(" +
                         std::to_string(streamId) + ", `" +
                         base64_encode(data.data(), data.size()) +
                         "`)}catch(e){console.error(e)};";
        if (scriptFlushScheduled) return;
        scriptFlushScheduled = true;
    }
    // dropped if the bridge is destroyed before it runs
    QMetaObject::invokeMethod(
        this,
        [this]() {
            std::string script;
            {
                std::lock_guard<std::mutex> lock(scriptMutex);
                script.swap(pendingScript);
                scriptFlushScheduled = false;
            }
            page->runJavaScript(QString::fromStdString(script));
        },
        Qt::QueuedConnection);
}

void QtBridge::startFrameStream(QWebEngineUrlRequestJob *job) {
    int gen = Core::streamAttach(ctx);
    if (gen < 0) {
        job->fail(QWebEngineUrlRequestJob::UrlNotFound);
        return;
    }
    auto *device = new FrameDevice(ctx, gen, job);
    job->reply("application/octet-stream", device);

    QPointer<FrameDevice> target(device);
    std::thread([ctx = ctx, gen, target]() {
        void *frames;
        int size = 0;
        while ((frames = Core::streamRead(ctx, gen, &size)) != nullptr) {
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
