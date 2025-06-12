#include "./unix.h"
#include <dlfcn.h>

CoreLib loadLibrary(std::string libPath) {
    auto coreLib = dlopen(libPath.c_str(), RTLD_LAZY);

    CoreLib lib = {
        (Directories)(dlsym(coreLib, "directories")),
        (Callback)(dlsym(coreLib, "callback")),
        (Call)(dlsym(coreLib, "call")),
        (GetResponse)(dlsym(coreLib, "getResponse")),
    };

    return lib;
}