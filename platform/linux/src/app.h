#ifndef APP_H
#define APP_H

#include "./instance.h"
#include <map>

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
        inline static App *instance;
        std::map<std::string, Instance *> activeWindows;
        std::string deeplink;
        bool kiosk = false;

        App();

        void onMessage(char *projectId, char *type, std::string message);

        void open(std::string projectId, bool isEditor);

        int run(int argc, char *argv[], std::string startupId);
};

#endif
