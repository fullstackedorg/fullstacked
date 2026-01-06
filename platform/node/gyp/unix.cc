#include "./unix.h"
#include <dlfcn.h>

CoreLib loadLibrary(std::string libPath) {
    auto coreLib = dlopen(libPath.c_str(), RTLD_LAZY);

    CoreLib lib = {
        (Start)(dlsym(coreLib, "start")),
        (Stop)(dlsym(coreLib, "stop")),
        (SetOnStreamData)(dlsym(coreLib, "setOnStreamData")),
        (Call)(dlsym(coreLib, "call")),
        (GetCorePayload)(dlsym(coreLib, "getCorePayload")),
    };

    return lib;
}