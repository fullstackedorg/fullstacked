#include "./app.h"
#include "./core.h"
#include "./utils.h"
#include <iostream>
#include <fstream>
#include <sys/stat.h>

std::string App::getConfig(uint8_t ctx, const std::string &key) {
    std::vector<uint8_t> payload = {
        ctx,
        0,  // id
        16, // Config Module
        0,  // Get
        1,  // Sync
        2   // STRING
    };
    uint32_t keyLen = static_cast<uint32_t>(key.size());
    payload.push_back(static_cast<uint8_t>((keyLen >> 24) & 0xFF));
    payload.push_back(static_cast<uint8_t>((keyLen >> 16) & 0xFF));
    payload.push_back(static_cast<uint8_t>((keyLen >> 8) & 0xFF));
    payload.push_back(static_cast<uint8_t>(keyLen & 0xFF));
    payload.insert(payload.end(), key.begin(), key.end());

    std::vector<uint8_t> res = Core::callCore(payload);
    if (res.size() > 6 && res[0] == 1 && res[1] == 2 /* STRING */) {
        uint32_t strLen = (static_cast<uint32_t>(res[2]) << 24) |
                          (static_cast<uint32_t>(res[3]) << 16) |
                          (static_cast<uint32_t>(res[4]) << 8) |
                          static_cast<uint32_t>(res[5]);
        if (res.size() >= 6 + strLen) {
            std::string str(reinterpret_cast<char*>(res.data() + 6), strLen);
            while (!str.empty() && (str.back() == ' ' || str.back() == '\t' || str.back() == '\n' || str.back() == '\r')) str.pop_back();
            while (!str.empty() && (str.front() == ' ' || str.front() == '\t' || str.front() == '\n' || str.front() == '\r')) str.erase(0, 1);
            if (!str.empty()) return str;
        }
    }

    return "";
}

uint8_t App::startMain(const std::string &root, const std::string &build, bool skipInitialDir) {
    uint8_t mainCtx = Core::start(root, build);
    if (skipInitialDir) {
        return mainCtx;
    }

    std::string initialDir = getConfig(mainCtx, "initialDirectory");
    if (!initialDir.empty()) {
        Core::stop(mainCtx);

        std::string subPath = (initialDir.front() == '/') ? initialDir.substr(1) : initialDir;
        std::string targetDir = root + "/" + subPath;
        return Core::start(targetDir, targetDir);
    }

    return mainCtx;
}

App::App() {
    App::instance = this;
}

App::~App() {
    delete gui;
}

void App::open(uint8_t ctx, bool skipInitialDir) {
    auto it = activeWindows.find(ctx);
    if (it != activeWindows.end()) {
        it->second->bringToFront(false);
        return;
    }

    if (Core::check(ctx) == 0) {
        Core::startWithCtx(rootDir, buildDir, ctx);
    }

    Window *window = gui->createWindow(ctx, skipInitialDir);
    activeWindows[ctx] = window;
    if (kiosk) {
        window->setFullscreen();
    }
}

void App::close(uint8_t ctx) {
    auto it = activeWindows.find(ctx);
    if (it != activeWindows.end()) {
        Window *window = it->second;
        activeWindows.erase(it);
        Core::stop(ctx);
    }
}

void App::panicRecovery() {
    for (auto const& [ctx, win] : activeWindows) {
        delete win;
        Core::stop(ctx);
    }
    activeWindows.clear();

    uint8_t mainCtx = startMain(rootDir, buildDir, true);
    open(mainCtx, true);
}

void App::onStreamData(uint8_t ctx, uint8_t streamId, const std::vector<uint8_t> &data) {
    auto it = activeWindows.find(ctx);
    if (it != activeWindows.end()) {
        it->second->onStreamData(streamId, data);
    }
}

int App::run(int argc, char *argv[]) {
    Core::init();
    Core::setStreamCallback([this](uint8_t ctx, uint8_t streamId, const std::vector<uint8_t> &data) {
        onStreamData(ctx, streamId, data);
    });

    const char *homeEnv = getenv("HOME");
    rootDir = (homeEnv ? std::string(homeEnv) : "/tmp") + "/FullStacked";
    buildDir = getAppDir();

    return gui->run(argc, argv, [this]() {
        uint8_t mainCtx = startMain(rootDir, buildDir, false);
        open(mainCtx);
    });
}
