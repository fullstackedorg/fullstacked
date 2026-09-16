#include "./app.h"
#include "./core.h"
#include "./utils.h"
#include <iostream>

App::App() {
    App::instance = this;
}

App::~App() {
    delete gui;
}

void App::open(uint8_t ctx) {
    auto it = activeWindows.find(ctx);
    if (it != activeWindows.end()) {
        it->second->bringToFront(false);
        return;
    }

    if (Core::check(ctx) == 0) {
        Core::startWithCtx(rootDir, buildDir, ctx);
    }

    Window *window = gui->createWindow(ctx);
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

void App::safeTrigger() {
    if (isSafeRunning) return;
    isSafeRunning = true;

    std::vector<uint8_t> ctxs;
    for (const auto &pair : activeWindows) {
        ctxs.push_back(pair.first);
    }
    for (uint8_t c : ctxs) {
        auto it = activeWindows.find(c);
        if (it != activeWindows.end()) {
            Window *w = it->second;
            activeWindows.erase(it);
            w->close();
            delete w;
        }
        Core::stop(c);
    }

    uint8_t safeCtx = Core::startSafe(rootDir, buildDir);
    open(safeCtx);

    isSafeRunning = false;
}

void App::onStreamData(uint8_t ctx, uint8_t streamId,
                       const std::vector<uint8_t> &data) {
    auto it = activeWindows.find(ctx);
    if (it != activeWindows.end()) {
        it->second->onStreamData(streamId, data);
    }
}

int App::run(int argc, char *argv[]) {
    Core::init();
    Core::setStreamCallback([this](uint8_t ctx, uint8_t streamId,
                                   const std::vector<uint8_t> &data) {
        onStreamData(ctx, streamId, data);
    });

    const char *homeEnv = getenv("HOME");
    rootDir = (homeEnv ? std::string(homeEnv) : "/tmp") + "/FullStacked";
    buildDir = getAppDir();

    return gui->run(argc, argv, [this]() {
        uint8_t mainCtx = this->safe ? Core::startSafe(rootDir, buildDir)
                                     : Core::start(rootDir, buildDir);
        open(mainCtx);
    });
}
