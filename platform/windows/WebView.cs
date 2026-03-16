using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Windows.Storage.Streams;

namespace FullStacked
{
    internal partial class WebView : Window
    {
        private byte ctx;
        private WebView2 webview = new();

        private static byte[] notFoundPayload = Encoding.UTF8.GetBytes("Not Found");

        private Dictionary<byte, TaskCompletionSource<byte[]>> syncAwaitersResolve = [];
        private Dictionary<byte, byte[]> syncAwaitersPayload = [];
        public WebView(byte ctx)
        {
            this.ctx = ctx;

            this.Title = "FullStacked";
            this.AppWindow.SetIcon("Assets/Window-Icon.ico");

            this.InitWebView();

            this.Content = this.webview;
            this.Activate();
        }

        async public void InitWebView()
        {
            await this.webview.EnsureCoreWebView2Async();
            this.webview.CoreWebView2.WebMessageReceived += delegate (CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
            {
                string base64 = args.TryGetWebMessageAsString();
                byte[] data = Convert.FromBase64String(base64);
                byte[] response = App.core.call(data);


                byte id = data[1];

                // Sync
                if (data[4] == 1)
                {
                    if (this.syncAwaitersResolve.ContainsKey(id))
                    {
                        this.syncAwaitersResolve[id].SetResult(response);
                    }
                    else
                    {
                        this.syncAwaitersPayload.Add(id, response);
                    }
                }
                // Async
                else
                {
                    _ = this.webview.CoreWebView2.ExecuteScriptAsync("window.respond(" + id + ",`" + Convert.ToBase64String(response) + "`)");
                }


            };
            this.webview.CoreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            this.webview.CoreWebView2.WebResourceRequested += async delegate (CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args)
            {
                Uri uri = new(args.Request.Uri);

                if (uri.Host != "localhost")
                {
                    return;
                }

                String pathname = uri.LocalPath;

                IRandomAccessStream stream;
                string headers;

                if (pathname == "/platform")
                {
                    (stream, headers) = this.bufferToResponseStream(Core.platform);
                    args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    return;
                }
                else if (pathname == "/ctx")
                {
                    byte[] ctxBuffer = Encoding.UTF8.GetBytes(this.ctx.ToString());
                    (stream, headers) = this.bufferToResponseStream(ctxBuffer);
                    args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    return;
                }
                else if (pathname.StartsWith("/sync"))
                {
                    string idStr = pathname.Split("/").Last();
                    byte id = byte.Parse(idStr);


                    Action<byte[]> sendCallback = (byte[] payload) =>
                    {
                        string b64 = Convert.ToBase64String(payload);
                        byte[] b64Buffer = Encoding.UTF8.GetBytes(b64);
                        (stream, headers) = this.bufferToResponseStream(b64Buffer, "application/octet-stream");
                        args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    };


                    if (this.syncAwaitersPayload.ContainsKey(id))
                    {
                        sendCallback(this.syncAwaitersPayload[id]);
                        this.syncAwaitersPayload.Remove(id);
                    }
                    else
                    {
                        using (args.GetDeferral())
                        {
                            TaskCompletionSource<byte[]> resolve = new();
                            this.syncAwaitersResolve.Add(id, resolve);
                            byte[] awaitedPayload = await resolve.Task;
                            this.syncAwaitersResolve.Remove(id);
                            sendCallback(awaitedPayload);
                        }
                    }

                    return;
                }

                // static file serving

                byte[] header = [
                    this.ctx,
                    0, // req id
                    0, // Core Module
                    0, // Fn Static File
                    0, // Async
                    
                    ((byte)SerializableDataType.STRING),
                ];

                byte[] pathnameData = Encoding.UTF8.GetBytes(pathname);
                byte[] pathnameLength = Serialization.NumberToUint4Bytes(pathnameData.Length);
                byte[] payload = Serialization.MergeBuffers([header, pathnameLength, pathnameData]);

                byte[] response = App.core.call(payload);

                (DataValue argBuffer, _) = Serialization.Deserialize(response, 1);

                List<DataValue> values = Serialization.DeserializeAll(argBuffer.buffer);

                if (values.Count < 2)
                {
                    (stream, headers) = this.bufferToResponseStream(WebView.notFoundPayload);
                    args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 404, "OK", headers);
                    return;
                }

                (stream, headers) = this.bufferToResponseStream(values[1].buffer, values[0].str);
                args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", headers);
            };

            this.webview.CoreWebView2.NewWindowRequested += delegate (CoreWebView2 sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                _ = Windows.System.Launcher.LaunchUriAsync(new Uri(e.Uri));
            };

            this.webview.Source = new Uri("http://localhost");
        }

        public void onStreamData(byte streamId, byte[] data)
        {
            this.webview.DispatcherQueue.TryEnqueue(DispatcherQueuePriority.High, () =>
            {
                _ = this.webview.CoreWebView2.ExecuteScriptAsync("window.callback(" + streamId + ", `" + Convert.ToBase64String(data) + "`)");
            });
        }

        private (IRandomAccessStream, string) bufferToResponseStream(byte[] buffer, string mimeType = "text/plain")
        {
            IRandomAccessStream stream = new MemoryStream(buffer).AsRandomAccessStream();

            string[] headers = [
                "Content-Type: " + mimeType,
                "Content-Length: " + buffer.Length,
                "Cache-Control: no-cache"
            ];

            return (stream, string.Join("\r\n", headers));
        }
    }
}
