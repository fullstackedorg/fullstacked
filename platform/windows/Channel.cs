using Microsoft.Web.WebView2.Core;
using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading;
using Windows.Foundation;

namespace FullStacked
{
    // The shared memory call channel of a page (improvements/perfs/windows.md 4A): one
    // CoreWebView2SharedBuffer per webview, posted to the page once it asks for it,
    // mapped in both processes (Buffer is the address of the mapping in this
    // process). Layout, offsets in the additionalData of the post:
    //
    //   sync request slot   [u32 state][u32 length][bytes]       one sync call at a time
    //   sync response slot  [u32 state][u32 length][u32 total][bytes]
    //   request ring        the async calls of the page, [payload] records
    //   response ring       their responses, [id u8][response] records
    //   frame ring          the stream frames (bridge/frames.ts), [bytes] records
    //
    // Sync: the page writes the call in the request slot, sets the state to REQUEST
    // and posts "#s"; the core queue of the bridge calls the core on the bytes in
    // place, writes the response in the response slot and publishes RESPONSE; the
    // page spins on the state. A response larger than the slot goes in chunks
    // (PARTIAL, the page acknowledges each with ACK).
    //
    // Async: the page appends the call to the request ring and posts "#a"; the
    // core queue pops it, calls the core in place and appends the response to the
    // response ring (a base64 reply in the "R" message when the ring is full);
    // the page drains the ring on the next "R" message, one per UI tick.
    //
    // Rings (Ring): [u32 head][u32 tail][pad to 64][data], one producer and one
    // consumer, records [u32 length][bytes] never wrap: a length of 0xFFFFFFFF, or
    // less than 4 bytes left, means the next record is at 0. A record leaves at
    // least one byte free so head == tail only when empty.
    internal unsafe class Channel
    {
        public const int STATE_FREE = 0;
        public const int STATE_REQUEST = 1;
        public const int STATE_RESPONSE = 3;
        public const int STATE_PARTIAL = 4;
        public const int STATE_ACK = 5;

        public const int SYNC_REQUEST_CAPACITY = 1 << 20;
        public const int SYNC_RESPONSE_CAPACITY = 1 << 20;
        public const int REQUEST_RING_SIZE = 2 << 20;
        public const int RESPONSE_RING_SIZE = 4 << 20;
        public const int FRAME_RING_SIZE = 4 << 20;

        private const int SYNC_REQUEST_OFFSET = 64;
        private const int SYNC_RESPONSE_OFFSET = SYNC_REQUEST_OFFSET + 8 + SYNC_REQUEST_CAPACITY;
        private const int REQUEST_RING_OFFSET = SYNC_RESPONSE_OFFSET + 12 + SYNC_RESPONSE_CAPACITY;
        private const int RESPONSE_RING_OFFSET = REQUEST_RING_OFFSET + Ring.HEADER + REQUEST_RING_SIZE;
        private const int FRAME_RING_OFFSET = RESPONSE_RING_OFFSET + Ring.HEADER + RESPONSE_RING_SIZE;
        private const int SIZE = FRAME_RING_OFFSET + Ring.HEADER + FRAME_RING_SIZE;

        private readonly CoreWebView2SharedBuffer buffer;
        // the mapping in this process, valid while the reference lives
        private readonly IMemoryBufferReference reference;
        private readonly byte* bytes;
        private readonly Ring requests;
        private readonly Ring responses;
        private readonly Ring frames;
        // set when the page went away; the mapping lives as long as this object so
        // a call still queued does not touch released memory
        private volatile bool closed;

        public Channel(CoreWebView2Environment environment)
        {
            this.buffer = environment.CreateSharedBuffer(SIZE);
            this.reference = this.buffer.Buffer;
            this.bytes = rawPointer(this.reference, SIZE);
            // zeroed by the system: the states start FREE, the rings empty
            this.requests = new Ring(this.bytes + REQUEST_RING_OFFSET, REQUEST_RING_SIZE);
            this.responses = new Ring(this.bytes + RESPONSE_RING_OFFSET, RESPONSE_RING_SIZE);
            this.frames = new Ring(this.bytes + FRAME_RING_OFFSET, FRAME_RING_SIZE);
        }

        public string Layout =>
            "{\"type\":\"calls\"" +
            ",\"syncRequest\":" + SYNC_REQUEST_OFFSET + ",\"syncRequestCapacity\":" + SYNC_REQUEST_CAPACITY +
            ",\"syncResponse\":" + SYNC_RESPONSE_OFFSET + ",\"syncResponseCapacity\":" + SYNC_RESPONSE_CAPACITY +
            ",\"requestRing\":" + REQUEST_RING_OFFSET + ",\"requestRingSize\":" + REQUEST_RING_SIZE +
            ",\"responseRing\":" + RESPONSE_RING_OFFSET + ",\"responseRingSize\":" + RESPONSE_RING_SIZE +
            ",\"frameRing\":" + FRAME_RING_OFFSET + ",\"frameRingSize\":" + FRAME_RING_SIZE + "}";

        public void Post(CoreWebView2 webview)
        {
            webview.PostSharedBufferToScript(this.buffer, CoreWebView2SharedBufferAccess.ReadWrite, this.Layout);
        }

        public void Close()
        {
            this.closed = true;
        }

        // IMemoryBufferByteAccess::GetBuffer of the reference (not projected)
        private static byte* rawPointer(IMemoryBufferReference reference, int size)
        {
            Guid iid = new("5B0D3235-4DBA-4D44-865E-8F1D0E4FD04D");
            IntPtr unknown = ((WinRT.IWinRTObject)reference).NativeObject.ThisPtr;
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(unknown, ref iid, out IntPtr byteAccess));
            try
            {
                IntPtr* vtable = *(IntPtr**)byteAccess;
                var getBuffer = (delegate* unmanaged[Stdcall]<IntPtr, byte**, uint*, int>)vtable[3];
                byte* ptr;
                uint capacity;
                Marshal.ThrowExceptionForHR(getBuffer(byteAccess, &ptr, &capacity));
                if (capacity < size) throw new InvalidOperationException("shared buffer mapping of " + capacity + " bytes");
                return ptr;
            }
            finally
            {
                Marshal.Release(byteAccess);
            }
        }

        internal static int load(byte* p) => Volatile.Read(ref Unsafe.AsRef<int>(p));
        // a release store: the bytes written before are visible once the word is
        internal static void store(byte* p, int v) => Volatile.Write(ref Unsafe.AsRef<int>(p), v);

        // A sync call of the page: calls the core on the request bytes in place and
        // publishes the response. On the core queue.
        public void Sync()
        {
            if (this.closed) return;
            byte* request = this.bytes + SYNC_REQUEST_OFFSET;
            byte* response = this.bytes + SYNC_RESPONSE_OFFSET;
            if (load(request) != STATE_REQUEST) return;
            int length = *(int*)(request + 4);
            if (length < 0 || length > SYNC_REQUEST_CAPACITY) return;
            byte* result = App.core.callChannel(request + 8, length, out int size);
            store(request, STATE_FREE);
            try
            {
                int offset = 0;
                while (true)
                {
                    int n = Math.Min(size - offset, SYNC_RESPONSE_CAPACITY);
                    if (n > 0) Buffer.MemoryCopy(result + offset, response + 12, SYNC_RESPONSE_CAPACITY, n);
                    *(int*)(response + 4) = n;
                    *(int*)(response + 8) = size;
                    offset += n;
                    if (offset >= size)
                    {
                        store(response, STATE_RESPONSE);
                        return;
                    }
                    store(response, STATE_PARTIAL);
                    // the page copies the chunk out and acknowledges, it is spinning on
                    // this slot (a sync call blocks its main thread)
                    SpinWait spin = new();
                    while (load(response) != STATE_ACK)
                    {
                        if (this.closed) return;
                        spin.SpinOnce();
                    }
                }
            }
            finally
            {
                App.core.freePtr(result);
            }
        }

        // The next async call of the request ring: calls the core on its bytes in
        // place and appends the response to the response ring. reply is the entry
        // of the "R" message when the response did not fit, null otherwise; false
        // when the ring had no call. On the core queue.
        public bool Async(out string reply)
        {
            reply = null;
            if (this.closed || !this.requests.Peek(out byte* payload, out int length)) return false;
            byte id = length > 1 ? payload[1] : (byte)0;
            byte* result = App.core.callChannel(payload, length, out int size);
            // the core copied the payload, the record can go
            this.requests.Pop(length);
            try
            {
                if (this.responses.Reserve(1 + size, out byte* record))
                {
                    record[0] = id;
                    if (size > 0) Buffer.MemoryCopy(result, record + 1, size, size);
                    this.responses.Commit(1 + size);
                }
                else
                {
                    reply = id + ":" + Convert.ToBase64String(new ReadOnlySpan<byte>(result, size));
                }
                return true;
            }
            finally
            {
                App.core.freePtr(result);
            }
        }

        // Appends a batch of stream frames to the frame ring, in records of at
        // most a quarter of the ring, waiting for the page to drain it when full
        // (backpressure, like a response stream the page reads). False once closed.
        public bool Frames(byte[] batch)
        {
            int max = FRAME_RING_SIZE / 4;
            int offset = 0;
            while (offset < batch.Length)
            {
                int n = Math.Min(batch.Length - offset, max);
                SpinWait spin = new();
                byte* record;
                while (!this.frames.Reserve(n, out record))
                {
                    if (this.closed) return false;
                    if (spin.NextSpinWillYield) Thread.Sleep(1); else spin.SpinOnce();
                }
                fixed (byte* source = batch)
                {
                    Buffer.MemoryCopy(source + offset, record, n, n);
                }
                this.frames.Commit(n);
                offset += n;
            }
            return true;
        }
    }

    // A ring of records in the shared buffer (see Channel). The host is the
    // producer of the response and frame rings and the consumer of the request
    // ring; the page keeps the other side.
    internal unsafe class Ring
    {
        public const int HEADER = 64;
        private const uint WRAP = 0xFFFFFFFF;

        private readonly byte* head;
        private readonly byte* tail;
        private readonly byte* data;
        private readonly int size;
        // the record reserved and not yet committed (producer)
        private int reservedAt = -1;

        public Ring(byte* ring, int size)
        {
            this.head = ring;
            this.tail = ring + 4;
            this.data = ring + HEADER;
            this.size = size;
        }

        // Producer: room for a record of length bytes, written at record before
        // Commit.
        public bool Reserve(int length, out byte* record)
        {
            record = null;
            int need = 4 + length;
            int head = Channel.load(this.head);
            int tail = Channel.load(this.tail);
            if (tail >= head)
            {
                // room after tail, at least a byte free after the record
                if (tail + need < this.size)
                {
                    this.reservedAt = tail;
                }
                // or at 0, after a wrap marker when there is room for one
                else if (head > need)
                {
                    if (tail + 4 <= this.size) *(uint*)(this.data + tail) = WRAP;
                    this.reservedAt = 0;
                }
                else return false;
            }
            else if (tail + need < head)
            {
                this.reservedAt = tail;
            }
            else return false;
            record = this.data + this.reservedAt + 4;
            return true;
        }

        public void Commit(int length)
        {
            *(uint*)(this.data + this.reservedAt) = (uint)length;
            Channel.store(this.tail, this.reservedAt + 4 + length);
            this.reservedAt = -1;
        }

        // Consumer: the next record, in place until Pop
        public bool Peek(out byte* record, out int length)
        {
            record = null;
            length = 0;
            int tail = Channel.load(this.tail);
            int head = Channel.load(this.head);
            while (true)
            {
                if (head == tail) return false;
                if (this.size - head < 4 || *(uint*)(this.data + head) == WRAP)
                {
                    head = 0;
                    Channel.store(this.head, 0);
                    continue;
                }
                length = (int)*(uint*)(this.data + head);
                record = this.data + head + 4;
                return true;
            }
        }

        public void Pop(int length)
        {
            int head = Channel.load(this.head);
            Channel.store(this.head, head + 4 + length);
        }
    }
}
