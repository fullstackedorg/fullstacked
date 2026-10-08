#ifndef APP_H
#define APP_H

#include "./gui.h"
#include <cstdint>
#include <map>
#include <memory>
#include <mutex>
#include <string>

#ifdef GTK
#include "./gtk/gtk.h"
#else
#include "./qt/qt.h"
#endif

class App {
    private:
#ifdef GTK
        GUI *gui = new WebkitGTKGUI();
#else
        GUI *gui = new QtGUI();
#endif

    public:
        inline static App *instance = nullptr;
        std::map<uint8_t, Window *> activeWindows;
        // activeWindows is changed on the main thread and read from core
        // threads by onStreamData, never hold it while calling the core
        std::mutex activeWindowsMutex;
        std::string rootDir;
        std::string buildDir;
        // fullstacked:// link the app was launched with
        std::string deeplink;
        bool kiosk = false;
        bool safe = false;
        bool isSafeRunning = false;

        App();
        ~App();

        void open(uint8_t ctx);
        void close(uint8_t ctx);
        void safeTrigger();
        void deepLink(const std::string &url);
        void onStreamData(uint8_t ctx, uint8_t streamId,
                          const std::vector<uint8_t> &data);

        int run(int argc, char *argv[]);
};

#endif
