#include <gtkmm/window.h>
#include <gtkmm/button.h>
#include <iostream>
#include <fstream>
#include "./app.h"
#include "./bin/linux-x86_64.h"
#include <filesystem>
#include <gtkmm/icontheme.h>

std::string getExePath()
{
    char result[PATH_MAX];
    ssize_t count = readlink("/proc/self/exe", result, PATH_MAX);
    std::string path = std::string(result, (count > 0) ? count : 0);
    return path;
}

std::string getEditorDir(){
    std::string path = getExePath();
    int pos = path.find_last_of("/");
    std::string dir = path.substr(0, pos);
    pos = dir.find_last_of("/");
    dir = path.substr(0, pos);
    return dir + "/share/fullstacked/editor";
}

void setDirectories()
{
    std::string home = getenv("HOME");
    std::string root = home + "/FullStacked";
    std::string config = home + "/.config/fullstacked";
    std::string editor = getEditorDir() ;

    directories(
        root.data(),
        config.data(),
        editor.data());
}

void libCallback(char *projectId, char *type, char *msg)
{
    App::instance->onMessage(projectId, type, msg);
}

void registerDeeplink()
{
    std::string dir = std::string(getenv("HOME")) + "/.local/share/applications";
    std::filesystem::create_directories(dir);

    std::ofstream customScheme(dir + "/fullstacked.desktop");

    std::string contents =
        "[Desktop Entry]\n"
        "Name=FullStacked\n"
        "Exec=" + getExePath() +" %u\n"
        "Terminal=false\n"
        "Type=Application\n"
        "MimeType=x-scheme-handler/fullstacked\n"
        "Icon=" + getEditorDir() + "/assets/dev-icon.png";

    customScheme << contents.c_str();
    customScheme.close();
    system(("update-desktop-database " + dir).c_str());

}

int main(int argc, char *argv[])
{
    registerDeeplink();
    setDirectories();
    callback((void *)libCallback);
    auto app = new App();
    app->deeplink = std::string(argc > 1 ? argv[1] : "");
    return app->run();
}