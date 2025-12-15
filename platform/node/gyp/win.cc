#include "./win.h"
#include <windows.h>

CoreLib loadLibrary(std::string libPath) {
    HINSTANCE coreLib = LoadLibrary(libPath.c_str());

    CoreLib lib = {
        (Start)GetProcAddress(coreLib, "start"),
        (Callback)GetProcAddress(coreLib, "callback"),
        (Call)GetProcAddress(coreLib, "call"),
        (GetResponse)GetProcAddress(coreLib, "getResponse"),
    };

    return lib;
}