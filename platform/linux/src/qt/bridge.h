#ifndef QtBridge_H_
#define QtBridge_H_

#include <QIODevice>
#include <QObject>
#include <QThreadPool>
#include <QWebEnginePage>
#include <QWebEngineUrlRequestJob>
#include <map>
#include <mutex>
#include <string>
#include <vector>

// The bridge between a page and the core (see core/internal/bundle/lib/bridge
// and perfs/porting.md), registered as `bridge` on the QWebChannel of the page:
// - small async calls: postMessage(base64) returns the response in base64
//   (empty when the core put a large response on the frame stream)
// - Qt < 6.7 reads no request body: sync calls are posted too and the page
//   reads their response with GET /sync/{id}
// - GET /stream: the stream data as binary frames
// - every other request of the page (static files, POST /call and /sync...) is
//   answered by the core
class QtBridge : public QObject {
        Q_OBJECT
    public:
        // the core sends large requests in the body of POST /call and /sync
        static const bool binaryCalls;

        QtBridge(uint8_t ctx, QWebEnginePage *page);

        // on the main thread
        void request(QWebEngineUrlRequestJob *job, const QString &path);
        // any thread
        void onStreamData(uint8_t streamId, const std::vector<uint8_t> &data);

    public slots:
        // the reply: the response in base64, empty when the core put a large
        // one on the frame stream or for a sync call (see request /sync/{id})
        QString postMessage(const QString &message);

    private:
        uint8_t ctx;
        QWebEnginePage *page;
        // POST /call and /sync run in order, off the main thread (one thread)
        QThreadPool *corePool;

        // sync calls of Qt < 6.7, main thread only
        std::map<uint8_t, QWebEngineUrlRequestJob *> syncJobs;
        std::map<uint8_t, std::vector<uint8_t>> syncResponses;
        void resolveSync(uint8_t id, const std::vector<uint8_t> &response);

        // stream chunks when the page reads no frames, evaluated once per
        // event loop iteration
        std::mutex scriptMutex;
        std::string pendingScript;
        bool scriptFlushScheduled = false;

        void startFrameStream(QWebEngineUrlRequestJob *job);
};

// Stream data of a context as binary frames for GET /stream (see
// core/internal/frames). A thread reads the frames from the core and appends
// them on the main thread, QtWebEngine reads the device as data comes from
// its IO thread, so the buffer is locked. Owned by the request job, detaches
// the reader when the job goes away.
class FrameDevice : public QIODevice {
        Q_OBJECT
    public:
        FrameDevice(uint8_t ctx, int gen, QObject *parent);
        ~FrameDevice() override;

        bool isSequential() const override {
            return true;
        }
        qint64 bytesAvailable() const override;
        bool atEnd() const override;

        void append(const QByteArray &frames);
        void finish();

    protected:
        qint64 readData(char *data, qint64 maxSize) override;
        qint64 writeData(const char *, qint64) override {
            return -1;
        }

    private:
        uint8_t ctx;
        int gen;
        mutable std::mutex mutex;
        QByteArray buffer;
        bool ended = false;
};

#endif
