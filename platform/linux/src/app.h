#ifndef APP_H
#define APP_H

#include "./gui.h"
#include <cstdint>
#include <map>
#include <memory>
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
    std::string rootDir;
    std::string buildDir;
    std::string deeplink;
    bool kiosk = false;

    App();
    ~App();

    std::string getConfig(uint8_t ctx, const std::string &key);
    uint8_t startMain(const std::string &root, const std::string &build, bool skipInitialDir = false);
    void open(uint8_t ctx, bool skipInitialDir = false);
    void close(uint8_t ctx);
    void panicRecovery();
    void onStreamData(uint8_t ctx, uint8_t streamId, const std::vector<uint8_t> &data);

    int run(int argc, char *argv[]);
};

#endif
