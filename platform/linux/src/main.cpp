#include "./app.h"
#include "./utils.h"
#include <string>

int main(int argc, char *argv[]) {
    registerDesktopApp();

    auto app = new App();

    std::string httpPrefix = "http";
    std::string fsPrefix = "fullstacked";
    std::string kioskFlag = "--kiosk";

    for (int i = 1; i < argc; i++) {
        std::string arg(argv[i]);

        if (arg.compare(0, httpPrefix.size(), httpPrefix) == 0 ||
            arg.compare(0, fsPrefix.size(), fsPrefix) == 0) {
            app->deeplink = arg;
        } else if (arg == kioskFlag) {
            app->kiosk = true;
        }
    }

    return app->run(argc, argv);
}