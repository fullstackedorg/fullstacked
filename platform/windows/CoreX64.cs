using System.Runtime.InteropServices;

namespace FullStacked
{
    unsafe internal class CoreX64 : CoreImplementation
    {

        const string dllName = "win32-x64.dll";

        [DllImport(dllName)]
        public static extern byte start(char* root, char* build);

        [DllImport(dllName)]
        public static extern byte startSafe(char* root, char* build);

        //extern void startWithCtx(char* root, char* build, uint8_t ctxId);
        //extern int check(uint8_t ctxId);

        [DllImport(dllName)]
        public static extern void stop(byte ctxId);

        [DllImport(dllName)]
        public static extern void setOnStreamData(CoreOnStreamData cb);

        [DllImport(dllName)]
        public static extern void getCorePayload(byte ctx, byte coreType, byte id, void* ptr, int size);

        [DllImport(dllName)]
        public static extern int call(void* buffer, int length);

        [DllImport(dllName)]
        public static extern void* callWithResponse(void* buffer, int length, int* size);

        [DllImport(dllName)]
        public static extern void freePtr(void* ptr);

        [DllImport(dllName)]
        public static extern int streamAttach(byte ctxId);

        [DllImport(dllName)]
        public static extern void* streamRead(byte ctxId, int gen, int* size);

        [DllImport(dllName)]
        public static extern void streamDetach(byte ctxId, int gen);

        public override byte startCore(char* root, char* build)
        {
            return start(root, build);
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
        public override void* callWithResponseCore(void* buffer, int length, int* size)
        {
            return callWithResponse(buffer, length, size);
        }
        public override void freePtrCore(void* ptr)
        {
            freePtr(ptr);
        }
        public override int streamAttachCore(byte ctxId)
        {
            return streamAttach(ctxId);
        }
        public override void* streamReadCore(byte ctxId, int gen, int* size)
        {
            return streamRead(ctxId, gen, size);
        }
        public override void streamDetachCore(byte ctxId, int gen)
        {
            streamDetach(ctxId, gen);
        }
    }
}
