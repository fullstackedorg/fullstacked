#include <stdint.h>

typedef uint8_t (*Start)(char *root, char *build);
typedef void (*Stop)(uint8_t ctx);
typedef void (*SetOnStreamData)(void *cb);
typedef int (*Call)(void *buffer, int length);
typedef void (*GetCorePayload)(uint8_t ctx, uint8_t coreType, uint8_t id,
                               void *ptr);

struct CoreLib {
        Start start;
        Stop stop;
        SetOnStreamData setOnStreamData;
        Call call;
        GetCorePayload getCorePayload;
};
