#include <stdint.h>

typedef uint8_t (*Start)(char *root, char *build);
typedef bool (*Check)(uint8_t ctx);
typedef void (*Stop)(uint8_t ctx);
typedef void (*SetOnStreamData)(void *cb);
typedef int (*Call)(void *buffer, int length);
typedef void (*GetCorePayload)(uint8_t ctx, uint8_t coreType, uint8_t id,
                               void *ptr, int size);
typedef int (*StreamAttach)(uint8_t ctx);
typedef void *(*StreamRead)(uint8_t ctx, int gen, int *size);
typedef void (*StreamDetach)(uint8_t ctx, int gen);
typedef void (*FreePtr)(void *ptr);

struct CoreLib {
        Start start;
        Check check;
        Stop stop;
        SetOnStreamData setOnStreamData;
        Call call;
        GetCorePayload getCorePayload;
        StreamAttach streamAttach;
        StreamRead streamRead;
        StreamDetach streamDetach;
        FreePtr freePtr;
};
