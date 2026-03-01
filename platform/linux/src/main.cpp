#include "../bin/linux.h"
#include "./app.h"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits.h>
#include <unistd.h>

std::string getExePath() {
    char result[PATH_MAX];
    ssize_t count = readlink("/proc/self/exe", result, PATH_MAX);
    std::string path = std::string(result, (count > 0) ? count : 0);
    return path;
}

std::string getEditorDir() {
    std::string path = getExePath();
    int pos = path.find_last_of("/");
    std::string dir = path.substr(0, pos);
    pos = dir.find_last_of("/");
    dir = path.substr(0, pos);
    return dir + "/share/fullstacked/editor";
}

void setDirectories() {
    std::string home = getenv("HOME");
    std::string root = home + "/FullStacked";
    std::string config = home + "/.config/fullstacked";
    std::string editor = getEditorDir();
    std::string tmp = root + "/.tmp";

    directories(root.data(), config.data(), editor.data(), tmp.data());
}

void libCallback(char *projectId, char *type, void *msgData, int msgLength) {
    std::string msg(static_cast<const char *>(msgData), msgLength);
    App::instance->onMessage(projectId, type, msg);
}

void replaceAll(std::string& str, const std::string& from, const std::string& to) {
    if(from.empty()) return; // Avoid infinite loop if 'from' is empty
    size_t start_pos = 0;
    while((start_pos = str.find(from, start_pos)) != std::string::npos) {
        str.replace(start_pos, from.length(), to);
        start_pos += to.length(); // Move past the newly inserted text
    }
}

void registerDesktopApp() {
    std::string localIconsDir =
        std::string(getenv("HOME")) + "/.local/share/icons";
    std::filesystem::create_directories(localIconsDir);
    std::string appIconFile = getEditorDir() + "/assets/icon.png";
    std::filesystem::copy_file(
        appIconFile, localIconsDir + "/fullstacked.png",
        std::filesystem::copy_options::overwrite_existing);

    std::string localAppsDir =
        std::string(getenv("HOME")) + "/.local/share/applications";
    std::filesystem::create_directories(localAppsDir);
    std::ofstream localAppFile(localAppsDir + "/fullstacked.desktop");
    std::string contents = "[Desktop Entry]\n"
                           "Name=FullStacked\n"
                           "Exec=" +
                           getExePath() +
                           " %u\n"
                           "Terminal=false\n"
                           "Type=Application\n"
                           "MimeType=x-scheme-handler/fullstacked\n"
                           "Icon=fullstacked\n"
                           "Categories=Development;Utility;";
    localAppFile << contents.c_str();
    localAppFile.close();

    replaceAll(localAppsDir, "\\", "\\\\");
    replaceAll(localAppsDir, "'", "\\'");
    
    std::string format = "update-desktop-database ";
    char command[format.size() + localAppsDir.size()];
    std::sprintf(command, std::string(format + "%s").c_str(), localAppsDir.c_str());

    system(command);
}

int main(int argc, char *argv[]) {
    registerDesktopApp();
    setDirectories();
    callback((void *)libCallback);
    auto app = new App();

    std::string httpPrefix = "http";
    std::string kioskFlag = "--kiosk";
    std::string startupId = "";
    for (int i = 1; i < argc; i++) {
        std::string arg(argv[i]);

        if (arg.compare(0, httpPrefix.size(), httpPrefix) == 0) {
            app->deeplink = arg;
        } else if (arg == kioskFlag) {
            app->kiosk = true;
            if (argc > i + 1) {
                startupId = std::string(argv[i + 1]);
                i++;
            }
        }
    }

    return app->run(argc, argv, startupId);
}