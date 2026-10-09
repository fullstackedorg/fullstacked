using System;
using System.Runtime.InteropServices;
using System.Text;

namespace FullStacked
{
    unsafe internal abstract class CoreImplementation
    {
        public abstract byte startCore(char* root, char* build);
        public abstract byte startSafeCore(char* root, char* build);
        public abstract void stopCore(byte ctxId);
        public abstract void setOnStreamDataCore(CoreOnStreamData cb);
        public abstract void getCorePayloadCore(byte ctx, byte coreType, byte id, void* ptr, int size);
        public abstract int callCore(void* buffer, int length);
        public abstract void* callWithResponseCore(void* buffer, int length, int* size);
        public abstract void* callMessageCore(void* buffer, int length, int* size);
        public abstract void setPlatformCore(byte* name, int binaryCalls);
        public abstract void* handleRequestCore(byte ctx, byte* path, void* body, int length, int* status, int* size);
        public abstract void freePtrCore(void* ptr);
        public abstract int streamAttachCore(byte ctxId);
        public abstract void* streamReadCore(byte ctxId, int gen, int* size);
        public abstract void streamDetachCore(byte ctxId, int gen);

        public delegate void CoreOnStreamData(byte ctx, byte streamId, int size);

    }

    unsafe public class Core
    {

        CoreImplementation lib;
        CoreCallbackDelegate onStreamData;
        private static CoreImplementation.CoreOnStreamData staticOnStreamDataDelegate;

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

            staticOnStreamDataDelegate = onStreamDataCore;
            this.lib.setOnStreamDataCore(staticOnStreamDataDelegate);

            // the page posts its calls to /call and /sync (WebResourceRequested reads bodies)
            fixed (byte* name = this.strToBufferUTF8("windows"))
            {
                this.lib.setPlatformCore(name, 1);
            }
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

        public byte startSafe(string root, string build)
        {
            byte[] rootBuffer = strToBufferUTF8(root);
            byte[] buildBuffer = strToBufferUTF8(build);

            fixed (byte* rootPtr = rootBuffer, buildPtr = buildBuffer)
            {
                return this.lib.startSafeCore((char*)rootPtr, (char*)buildPtr);
            }
        }

        public void stop(byte ctxId)
        {
            this.lib.stopCore(ctxId);
        }

        private static void onStreamDataCore(byte ctx, byte streamId, int size)
        {
            try
            {
                byte[] data = new byte[size];

                fixed (byte* ptr = data)
                {
                    App.core?.lib?.getCorePayloadCore(ctx, 2, streamId, ptr, size);
                }

                App.core?.onStreamData(ctx, streamId, data);
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Error in onStreamDataCore: {ex}");
            }
        }
        // Thread safe: the core synchronizes per context, responses are returned
        // directly instead of being stored by request id.
        public byte[] call(byte[] payload)
        {
            int responseSize = 0;
            void* responsePtr;
            fixed (byte* payloadPtr = payload)
            {
                responsePtr = this.lib.callWithResponseCore(payloadPtr, payload.Length, &responseSize);
            }
            if (responsePtr == null || responseSize <= 0)
            {
                return [];
            }
            byte[] response = new byte[responseSize];
            Marshal.Copy((IntPtr)responsePtr, response, 0, responseSize);
            this.lib.freePtrCore(responsePtr);
            return response;
        }

        public record Response(int status, string mimeType, byte[] data);

        // A request of the page answered by the core (static files, /platform, /ctx,
        // POST /call and /sync...)
        public Response request(byte ctx, string path, byte[] body)
        {
            int status = 0;
            int size = 0;
            void* responsePtr;
            fixed (byte* pathPtr = this.strToBufferUTF8(path), bodyPtr = body)
            {
                responsePtr = this.lib.handleRequestCore(ctx, pathPtr, bodyPtr, body.Length, &status, &size);
            }
            byte[] response = new byte[size];
            Marshal.Copy((IntPtr)responsePtr, response, 0, size);
            this.lib.freePtrCore(responsePtr);
            // "<mime type>\n<body>"
            int newline = Array.IndexOf(response, (byte)'\n');
            if (newline < 0) newline = response.Length;
            string mimeType = Encoding.UTF8.GetString(response, 0, newline);
            byte[] data = newline < response.Length ? response[(newline + 1)..] : [];
            return new Response(status, mimeType, data);
        }

        // A call received on a message channel: the response, or null when the core
        // queued it on the frame stream (large responses).
        public byte[] callMessage(byte[] payload)
        {
            int responseSize = 0;
            void* responsePtr;
            fixed (byte* payloadPtr = payload)
            {
                responsePtr = this.lib.callMessageCore(payloadPtr, payload.Length, &responseSize);
            }
            if (responseSize < 0)
            {
                return null;
            }
            if (responsePtr == null || responseSize == 0)
            {
                return [];
            }
            byte[] response = new byte[responseSize];
            Marshal.Copy((IntPtr)responsePtr, response, 0, responseSize);
            this.lib.freePtrCore(responsePtr);
            return response;
        }

        // Stream data of a context as binary frames for GET /stream, see
        // core/internal/frames. Returns the reader generation, -1 for an unknown context.
        public int streamAttach(byte ctxId)
        {
            return this.lib.streamAttachCore(ctxId);
        }

        // Blocks until frames are queued, null once the reader ended.
        public byte[] streamRead(byte ctxId, int gen)
        {
            int size = 0;
            void* frames = this.lib.streamReadCore(ctxId, gen, &size);
            if (frames == null || size <= 0)
            {
                return null;
            }
            byte[] data = new byte[size];
            Marshal.Copy((IntPtr)frames, data, 0, size);
            this.lib.freePtrCore(frames);
            return data;
        }

        public void streamDetach(byte ctxId, int gen)
        {
            this.lib.streamDetachCore(ctxId, gen);
        }

        // Calls Core Fn DeepLink in ctx: the deeplink plugins of ctx receive url.
        public void deepLink(byte ctx, string url)
        {
            byte[] header = [
                ctx,
                0, // req id, unused by callWithResponse
                0, // Core Module
                6, // Fn DeepLink
                0, // Async

                ((byte)SerializableDataType.STRING),
            ];
            byte[] urlData = Encoding.UTF8.GetBytes(url);
            byte[] urlLength = Serialization.NumberToUint4Bytes(urlData.Length);
            this.call(Serialization.MergeBuffers([header, urlLength, urlData]));
        }

        public delegate void CoreCallbackDelegate(byte ctx, byte streamId, byte[] data);

    }
}

