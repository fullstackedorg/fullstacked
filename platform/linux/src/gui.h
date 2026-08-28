#ifndef GUI_H_
#define GUI_H_

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

class Window {
public:
    uint8_t ctx = 0;
    virtual ~Window() = default;

    virtual void onStreamData(uint8_t streamId, const std::vector<uint8_t> &data) = 0;
    virtual void bringToFront(bool reload) = 0;
    virtual void setFullscreen() = 0;
    virtual void setTitle(const std::string &title) = 0;
    virtual void evaluateJavaScript(const std::string &script) = 0;
    virtual std::string getSize() = 0;
    virtual void resize(const std::string &size) = 0;
    virtual void close() = 0;
};

class GUI {
public:
    virtual ~GUI() = default;

    virtual int run(int &argc, char **argv, std::function<void()> onReady) = 0;
    virtual Window *createWindow(uint8_t ctx) = 0;
};

#endif