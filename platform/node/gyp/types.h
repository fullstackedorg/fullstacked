#include <stdint.h>

typedef void (*Directories)(char *root, char *config, char *main, char *lib);
typedef void (*Callback)(void *cb);
typedef int (*Call)(void *buffer, int length);
typedef void (*GetResponse)(uint8_t id, void *ptr);

struct CoreLib {
        Directories directories;
        Callback callback;
        Call call;
        GetResponse getResponse;
};
