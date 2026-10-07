using System.Runtime.InteropServices;

namespace FullStacked
{
    unsafe internal class CoreX64 : CoreImplementation
    {

        const string dllName = "win32-x64.dll";

        [DllImport(dllName)]
        public static extern byte start(char* root, char* build, char* deeplink);

        [DllImport(dllName)]
        public static extern byte startSafe(char* root, char* build);

        //extern void startWithCtx(char* root, char* build, uint8_t ctxId, char* deeplink);
        //extern int check(uint8_t ctxId);

        [DllImport(dllName)]
        public static extern void stop(byte ctxId);

        [DllImport(dllName)]
        public static extern void setOnStreamData(CoreOnStreamData cb);

        [DllImport(dllName)]
        public static extern void getCorePayload(byte ctx, byte coreType, byte id, void* ptr, int size);

        [DllImport(dllName)]
        public static extern int call(void* buffer, int length);

        //public static extern void freePtr(void* ptr);
        public override byte startCore(char* root, char* build, char* deeplink)
        {
            return start(root, build, deeplink);
        }

        public override byte startSafeCore(char* root, char* build)
        {
            return startSafe(root, build);
        }

        public override void stopCore(byte ctxId)
        {
            stop(ctxId);
        }

        public override void setOnStreamDataCore(CoreOnStreamData cb)
        {
            setOnStreamData(cb);
        }
        public override void getCorePayloadCore(byte ctx, byte coreType, byte id, void* ptr, int size)
        {
            getCorePayload(ctx, coreType, id, ptr, size);
        }
        public override int callCore(void* buffer, int length)
        {
            return call(buffer, length);
        }
    }
}
