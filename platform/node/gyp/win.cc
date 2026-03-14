#include "./win.h"
#include <windows.h>

CoreLib loadLibrary(std::string libPath) {
    HINSTANCE coreLib = LoadLibrary(libPath.c_str());

    CoreLib lib = {
        (Start)GetProcAddress(coreLib, "start"),
        (Stop)GetProcAddress(coreLib, "stop"),
        (SetOnStreamData)GetProcAddress(coreLib, "setOnStreamData"),
        (Call)GetProcAddress(coreLib, "call"),
        (GetCorePayload)GetProcAddress(coreLib, "getCorePayload"),
    };

    return lib;
}
