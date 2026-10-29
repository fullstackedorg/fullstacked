using Microsoft.UI.Dispatching;
using Microsoft.Web.WebView2.Core;
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Storage.Streams;

namespace FullStacked
{
    // The bridge between a page and the core (see core/internal/bundle/lib/bridge and
    // improvements/perfs/porting.md):
    // - calls: a shared buffer mapped in both processes (Channel.cs) that the page
    //   asks for with "#channel": sync calls in a slot the page spins on ("#s"),
    //   async calls and their responses in rings ("#a"), the stream frames in a ring;
    //   the page drains the rings on "R" messages, one per UI tick
    // - async calls before the channel, or when its ring is full: web messages, the
    //   payload in base64, replied in the "R" message as "<id>:<base64>;..." (empty
    //   when the core put a large response on the frame stream)
    // - GET /stream: WebView2 reads a response stream entirely before answering, the
    //   frames are posted to the page in shared buffers instead
    // - every other request of the page (static files, POST /sync...) is answered by the core
    internal class Bridge
    {
        private readonly byte ctx;
        private readonly DispatcherQueue uiQueue;
        private CoreWebView2 webview;
        private CoreWebView2Environment environment;

        // the calls of the page run in order, off the UI thread
        private readonly object coreQueueLock = new();
        private Task coreQueue = Task.CompletedTask;

        // the shared memory call channel, created when the page asks for it
        private Channel channel;

        public Bridge(byte ctx, DispatcherQueue uiQueue)
        {
            this.ctx = ctx;
            this.uiQueue = uiQueue;
        }

        public void Attach(CoreWebView2 webview, CoreWebView2Environment environment)
        {
            this.webview = webview;
            this.environment = environment;
            webview.WebMessageReceived += (sender, args) => this.onWebMessage(args.TryGetWebMessageAsString());
        }

        public void Close()
        {
            this.stopFrameStream();
            this.webview = null;
            this.channel?.Close();
            this.channel = null;
        }

        // UI thread
        private void onWebMessage(string message)
        {
            if (message == null) return;
            switch (message)
            {
                case "#channel":
                    // the page (re)loaded: a fresh channel, the previous one ends
                    try
                    {
                        this.channel?.Close();
                        this.channel = new Channel(this.environment);
                        this.channel.Post(this.webview);
                    }
                    catch (Exception ex)
                    {
                        // the page falls back to POST /sync after its timeout
                        System.Diagnostics.Debug.WriteLine($"Error creating the shared channel: {ex}");
                    }
                    return;
                case "#s":
                {
                    Channel channel = this.channel;
                    this.enqueue(() =>
                    {
                        try
                        {
                            channel?.Sync();
                        }
                        catch (Exception ex)
                        {
                            System.Diagnostics.Debug.WriteLine($"Error in sync channel call: {ex}");
                        }
                        return true;
                    });
                    return;
                }
                case "#a":
                {
                    Channel channel = this.channel;
                    this.enqueue(() =>
                    {
                        try
                        {
                            if (channel != null && channel.Async(out string reply)) this.queueReply(reply);
                        }
                        catch (Exception ex)
                        {
                            System.Diagnostics.Debug.WriteLine($"Error in async channel call: {ex}");
                        }
                        return true;
                    });
                    return;
                }
                default:
                    this.onCallMessage(message);
                    return;
            }
        }

        private Task<T> enqueue<T>(Func<T> call)
        {
            lock (this.coreQueueLock)
            {
                Task<T> task = this.coreQueue.ContinueWith(_ => call(), TaskScheduler.Default);
                this.coreQueue = task;
                return task;
            }
        }

        // replies to the call messages, posted once per UI tick in one "R" message,
        // which also tells the page to drain the rings of the channel (reply null)
        private readonly object replyLock = new();
        private readonly StringBuilder pendingReplies = new();
        private bool replyFlushScheduled = false;

        private void onCallMessage(string base64)
        {
            this.enqueue(() =>
            {
                try
                {
                    byte[] payload = Convert.FromBase64String(base64);
                    byte[] response = App.core.callMessage(payload);
                    this.queueReply(payload[1] + ":" + (response == null ? "" : Convert.ToBase64String(response)));
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"Error in call message: {ex}");
                }
                return true;
            });
        }

        private void queueReply(string reply)
        {
            lock (this.replyLock)
            {
                if (reply != null)
                {
                    if (this.pendingReplies.Length > 0) this.pendingReplies.Append(';');
                    this.pendingReplies.Append(reply);
                }
                if (this.replyFlushScheduled) return;
                this.replyFlushScheduled = true;
            }
            this.uiQueue.TryEnqueue(DispatcherQueuePriority.High, () =>
            {
                string replies;
                lock (this.replyLock)
                {
                    replies = this.pendingReplies.ToString();
                    this.pendingReplies.Clear();
                    this.replyFlushScheduled = false;
                }
                this.webview?.PostWebMessageAsString("R" + replies);
            });
        }

        // stream chunks when the page reads no frames, evaluated once per UI tick, a
        // statement that throws does not stop the others of the batch
        private readonly object scriptLock = new();
        private readonly StringBuilder pendingScript = new();
        private bool scriptFlushScheduled = false;

        public void OnStreamData(uint streamId, byte[] data)
        {
            lock (this.scriptLock)
            {
                this.pendingScript.Append("try{window.fullstacked.onStreamData(" + streamId + ", `" + Convert.ToBase64String(data) + "`)}catch(e){console.error(e)};");
                if (this.scriptFlushScheduled) return;
                this.scriptFlushScheduled = true;
            }
            this.uiQueue.TryEnqueue(DispatcherQueuePriority.High, () =>
            {
                string script;
                lock (this.scriptLock)
                {
                    script = this.pendingScript.ToString();
                    this.pendingScript.Clear();
                    this.scriptFlushScheduled = false;
                }
                _ = this.webview?.ExecuteScriptAsync(script);
            });
        }

        // a request of the page, on the UI thread
        public async Task Request(CoreWebView2WebResourceRequestedEventArgs args, string path)
        {
            if (path == "/stream")
            {
                this.startFrameStream();
                args.Response = this.response(200, "text/plain", []);
                return;
            }
            using (args.GetDeferral())
            {
                byte[] body = await readRequestBody(args.Request);
                Func<Core.Response> call = () => App.core.request(this.ctx, path, body);
                Core.Response response = path == "/call" || path == "/sync"
                    ? await this.enqueue(call)
                    : await Task.Run(call);
                args.Response = this.response(response.status, response.mimeType, response.data);
            }
        }

        private CoreWebView2WebResourceResponse response(int status, string mimeType, byte[] data)
        {
            IRandomAccessStream stream = new MemoryStream(data).AsRandomAccessStream();
            string headers = "Content-Type: " + mimeType + "\r\nContent-Length: " + data.Length + "\r\nCache-Control: no-cache";
            return this.environment.CreateWebResourceResponse(stream, status, status == 200 ? "OK" : "Not Found", headers);
        }

        private static async Task<byte[]> readRequestBody(CoreWebView2WebResourceRequest request)
        {
            IRandomAccessStream content = request.Content;
            if (content == null) return [];
            using Stream body = content.AsStreamForRead();
            using MemoryStream buffer = new();
            await body.CopyToAsync(buffer);
            return buffer.ToArray();
        }

        // reader generation of the frames posted to the page, UI thread only
        private int frameStreamGen = -1;

        // A thread reads the frames from the core until the context ends, the page
        // reloads or detaches (GET /stream/detach, answered by the core), and hands
        // them to the page through the frame ring of the channel, or in a shared
        // buffer per batch without one
        private void startFrameStream()
        {
            this.stopFrameStream();
            byte ctx = this.ctx;
            int gen = App.core.streamAttach(ctx);
            if (gen < 0) return;
            this.frameStreamGen = gen;
            Channel channel = this.channel;
            new Thread(() =>
            {
                byte[] frames;
                while ((frames = App.core.streamRead(ctx, gen)) != null)
                {
                    byte[] batch = frames;
                    if (channel != null)
                    {
                        // false once the page went away, a new page attaches its own reader
                        if (!channel.Frames(batch)) break;
                        this.queueReply(null);
                    }
                    else
                    {
                        this.uiQueue.TryEnqueue(() => this.postFrames(gen, batch));
                    }
                }
            })
            {
                IsBackground = true,
                Name = "FullStacked stream frames"
            }.Start();
        }

        private void stopFrameStream()
        {
            if (this.frameStreamGen < 0) return;
            App.core.streamDetach(this.ctx, this.frameStreamGen);
            this.frameStreamGen = -1;
        }

        private void postFrames(int gen, byte[] frames)
        {
            if (gen != this.frameStreamGen || this.webview == null) return;
            try
            {
                // closing on this side does not affect the access of the page
                using CoreWebView2SharedBuffer sharedBuffer = this.environment.CreateSharedBuffer((ulong)frames.Length);
                // OpenStream is a WinRT stream, unbuffered adapter so the frames are written once
                using (Stream stream = sharedBuffer.OpenStream().AsStreamForWrite(0))
                {
                    stream.Write(frames, 0, frames.Length);
                }
                this.webview.PostSharedBufferToScript(sharedBuffer, CoreWebView2SharedBufferAccess.ReadOnly, "{\"type\":\"frames\"}");
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Error posting stream frames: {ex}");
            }
        }
    }
}
