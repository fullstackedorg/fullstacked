#include "./app.h"
#include <iostream>

App::App() {
    App::instance = this;
}

void App::onMessage(char *projectId, char *type, std::string message) {
    auto exists = activeWindows.find(projectId);
    if (exists != activeWindows.end()) {
        exists->second->onMessage(type, message);
    }
}

void App::open(std::string projectId, bool isEditor) {
    auto exists = activeWindows.find(projectId);
    if (exists != activeWindows.end()) {
        exists->second->window->bringToFront(true);
    } else {
        Instance *instance = new Instance(projectId, isEditor);
        Window *window = gui->createWindow(
            [instance](std::string path) { return instance->onRequest(path); },
            [instance](std::string payload) {
                return instance->onBridge(payload);
            });
        instance->window = window;
        activeWindows[projectId] = instance;
        if (kiosk) {
            instance->window->setFullscreen();
        }
    }
}

int App::run(int argc, char *argv[], std::string startupId) {
    return gui->run(argc, argv, [&]() { open(startupId, startupId == ""); });
}
