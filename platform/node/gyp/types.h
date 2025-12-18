#include <stdint.h>

typedef uint8_t (*Start)(char *directory);
typedef void (*Stop)(uint8_t ctx);
typedef void (*Callback)(void *cb);
typedef int (*Call)(void *buffer, int length);
typedef void (*GetResponse)(uint8_t ctx, uint8_t id, void *ptr);

struct CoreLib {
        Start start;
        Stop stop;
        Callback callback;
        Call call;
        GetResponse getResponse;
};
