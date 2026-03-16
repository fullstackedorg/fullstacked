using System;
using System.Runtime.InteropServices;
using System.Text;

namespace FullStacked
{
    unsafe internal abstract class CoreImplementation
    {
        public abstract byte startCore(char* root, char* build);
        public abstract void stopCore(byte ctxId);
        public abstract void setOnStreamDataCore(CoreOnStreamData cb);
        public abstract void getCorePayloadCore(byte ctx, byte coreType, byte id, void* ptr, int size);
        public abstract int callCore(void* buffer, int length);

        public delegate void CoreOnStreamData(byte ctx, byte streamId, int size);

    }

    unsafe public class Core
    {
        public static byte[] platform = Encoding.UTF8.GetBytes("windows");
        CoreImplementation lib;
        CoreCallbackDelegate onStreamData;

        public Core(CoreCallbackDelegate onStreamData)
        {
            this.onStreamData = onStreamData;

            switch (RuntimeInformation.ProcessArchitecture)
            {
                case Architecture.X64:
                    this.lib = new CoreX64();
                    break;
                case Architecture.Arm64:
                    this.lib = new CoreARM64();
                    break;
                default:
                    throw new Exception("Unsupported arch");
            }

            this.lib.setOnStreamDataCore(onStreamDataCore);
        }

        private byte[] strToBufferUTF8(string str) {
            byte[] strUTF8 = Encoding.UTF8.GetBytes(str);
            byte[] buffer = new byte[strUTF8.Length + 1];
            Buffer.BlockCopy(strUTF8, 0, buffer, 0, strUTF8.Length);
            buffer[strUTF8.Length] = 0;
            return buffer;
        }

        public byte start(string root, string build)
        {
            byte[] rootBuffer = strToBufferUTF8(root);
            byte[] buildBuffer = strToBufferUTF8(build);

            fixed (byte* rootPtr = rootBuffer, buildPtr = buildBuffer)
            {
                return this.lib.startCore((char*)rootPtr, (char*)buildPtr);
            }
        }
        public void stop(byte ctxId)
        {
            this.lib.stopCore(ctxId);
        }

        private static void onStreamDataCore(byte ctx, byte streamId, int size)
        {
            byte[] data = new byte[size];

            fixed (byte* ptr = data)
            {
                App.core.lib.getCorePayloadCore(ctx, 2, streamId, ptr, size);
            }

            App.core.onStreamData(ctx, streamId, data);
        }
        public byte[] call(byte[] payload)
        {
            int responseSize;
            fixed (byte* payloadPtr = payload)
            {
                responseSize = this.lib.callCore(payloadPtr, payload.Length);
            }
            byte[] response = new byte[responseSize];
            fixed (byte* responsePtr = response)
            {
                this.lib.getCorePayloadCore(payload[0], 1, payload[1], responsePtr, responseSize);
            }
            return response;
        }

        public delegate void CoreCallbackDelegate(byte ctx, byte streamId, byte[] data);

    }
}
