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
                } else if (pathname.StartsWith("/resize")) {
                    var queryParams = new Dictionary<string, string>();
                    string query = uri.Query.TrimStart('?');
                    if (!string.IsNullOrEmpty(query))
                    {
                        foreach (string part in query.Split('&'))
                        {
                            string[] kv = part.Split('=');
                            if (kv.Length == 2)
                            {
                                queryParams[kv[0]] = Uri.UnescapeDataString(kv[1]);
                            }
                        }
                    }

                    if (queryParams.TryGetValue("kiosk", out string kioskVal) && kioskVal == "true")
                    {
                        this.AppWindow.SetPresenter(Microsoft.UI.Windowing.AppWindowPresenterKind.FullScreen);
                        (stream, headers) = this.bufferToResponseStream([]);
                        args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    }
                    else if (queryParams.TryGetValue("fullscreen", out string fsVal) && fsVal == "true")
                    {
                        this.AppWindow.SetPresenter(Microsoft.UI.Windowing.AppWindowPresenterKind.Default);
                        var overlappedPresenter = this.AppWindow.Presenter as Microsoft.UI.Windowing.OverlappedPresenter;
                        if (overlappedPresenter != null)
                        {
                            overlappedPresenter.Maximize();
                        }
                        (stream, headers) = this.bufferToResponseStream([]);
                        args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    }
                    else if (queryParams.TryGetValue("width", out string wStr) &&
                             queryParams.TryGetValue("height", out string hStr))
                    {
                        int w = int.Parse(wStr);
                        int h = int.Parse(hStr);

                        if (this.AppWindow.Presenter.Kind == Microsoft.UI.Windowing.AppWindowPresenterKind.FullScreen)
                        {
                            this.AppWindow.SetPresenter(Microsoft.UI.Windowing.AppWindowPresenterKind.Default);
                        }
                        var overlappedPresenter = this.AppWindow.Presenter as Microsoft.UI.Windowing.OverlappedPresenter;
                        if (overlappedPresenter != null && overlappedPresenter.State == Microsoft.UI.Windowing.OverlappedPresenterState.Maximized)
                        {
                            overlappedPresenter.Restore();
                        }

                        if (queryParams.TryGetValue("x", out string xStr) &&
                            queryParams.TryGetValue("y", out string yStr))
                        {
                            int x = int.Parse(xStr);
                            int y = int.Parse(yStr);
                            this.AppWindow.MoveAndResize(new Windows.Graphics.RectInt32(x, y, w, h));
                        }
                        else
                        {
                            int currentW = this.AppWindow.Size.Width;
                            int currentH = this.AppWindow.Size.Height;
                            int currentX = this.AppWindow.Position.X;
                            int currentY = this.AppWindow.Position.Y;

                            int newX = currentX + (currentW - w) / 2;
                            int newY = currentY + (currentH - h) / 2;

                            this.AppWindow.MoveAndResize(new Windows.Graphics.RectInt32(newX, newY, w, h));
                        }

                        (stream, headers) = this.bufferToResponseStream([]);
                        args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    }
                    else
                    {
                        string responseStr = "";
                        var overlappedPresenter = this.AppWindow.Presenter as Microsoft.UI.Windowing.OverlappedPresenter;
                        if (this.AppWindow.Presenter.Kind == Microsoft.UI.Windowing.AppWindowPresenterKind.FullScreen)
                        {
                            responseStr = "kiosk";
                        }
                        else if (overlappedPresenter != null && overlappedPresenter.State == Microsoft.UI.Windowing.OverlappedPresenterState.Maximized)
                        {
                            responseStr = "fullscreen";
                        }
                        else
                        {
                            int width = this.AppWindow.Size.Width;
                            int height = this.AppWindow.Size.Height;
                            int x = this.AppWindow.Position.X;
                            int y = this.AppWindow.Position.Y;
                            responseStr = $"{width}:{height}:{x}:{y}";
                        }

                        byte[] responseBuffer = Encoding.UTF8.GetBytes(responseStr);
                        (stream, headers) = this.bufferToResponseStream(responseBuffer);
                        args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", headers);
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
                Uri url = new(e.Uri);
                if (url.Query.Contains("auth")) {
                    return;
                }

                e.Handled = true;
                _ = Windows.System.Launcher.LaunchUriAsync(url);
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
