using System;

namespace FullStacked
{
    unsafe internal abstract class Lib
    {
        public abstract void setDirectories(void* root, void* config, void* editor, void* tmp);
        public abstract void setCallback(CallbackDelegate cb);

        public delegate void CallbackDelegate(string projectId, string messageType, IntPtr message, int messageLength);

        public abstract int callLib(int id, byte* payload, int size);
        public abstract void getReponseLib(int id, byte* ptr);
        public abstract void freePtrLib(void* ptr);
    }
}
