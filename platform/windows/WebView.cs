using Microsoft.UI;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
using Windows.Storage.Streams;

namespace FullStacked
{
    internal partial class WebView : Window
    {
        private byte ctx;
        private WebView2 webview = new();

        public WebView(byte ctx)
        {
            this.ctx = ctx;
            this.Init();
            this.Content = this.webview;
            this.Activate();
        }

        async public void Init()
        {
            await this.webview.EnsureCoreWebView2Async();
            this.webview.CoreWebView2.WebMessageReceived += delegate (CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
            {
                string base64 = args.TryGetWebMessageAsString();
                byte[] data = Convert.FromBase64String(base64);
                byte[] response = App.core.call(data);
                _ = this.webview.CoreWebView2.ExecuteScriptAsync("window.respond(`" + Convert.ToBase64String(response) + "`)");
            };
            this.webview.CoreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            this.webview.CoreWebView2.WebResourceRequested += delegate (CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args)
            {
                Uri uri = new(args.Request.Uri);

                if (uri.Host != "localhost")
                {
                    return;
                }

                String pathname = uri.LocalPath;

                if (pathname == "/platform")
                {
                    IRandomAccessStream stream = new MemoryStream(Core.platform).AsRandomAccessStream();
                    string[] headersPlatform = {
                        "Content-Type: text/html",
                        "Content-Length: " + Core.platform.Length
                    };
                    args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", string.Join("\r\n", headersPlatform));
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
                    byte[] notFoundData = Encoding.UTF8.GetBytes("Not Found");
                    string[] headersNotFound = {
                        "Content-Type: text/plain",
                        "Content-Length: " + notFoundData.Length,
                        "Cache-Control: no-cache"
                    };
                    IRandomAccessStream notFoundStream = new MemoryStream(notFoundData).AsRandomAccessStream();
                    args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(notFoundStream, 404, "OK", string.Join("\r\n", headersNotFound));
                    return;
                }

                string[] headers = {
                    "Content-Type: " + values[0].str,
                    "Content-Length: " + values[1].buffer.Length,
                    "Cache-Control: no-cache"
                };
                IRandomAccessStream resStream = new MemoryStream(values[1].buffer).AsRandomAccessStream();
                args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(resStream, 200, "OK", string.Join("\r\n", headers));
            };

            this.webview.CoreWebView2.NewWindowRequested += delegate (CoreWebView2 sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                e.Handled = true;
                _ = Windows.System.Launcher.LaunchUriAsync(new Uri(e.Uri));
            };

            this.webview.CoreWebView2.NavigationCompleted += async delegate (CoreWebView2 sender, CoreWebView2NavigationCompletedEventArgs e)
            {
                AppWindowTitleBar titleBar = this.AppWindow.TitleBar;
            };

            this.webview.Source = new Uri("http://localhost");
        }

        public void onStreamData(byte streamId, byte[] data)
        {
            this.webview.DispatcherQueue.TryEnqueue(DispatcherQueuePriority.High, () =>
            {
                _ = this.webview.CoreWebView2.ExecuteScriptAsync("window.oncoremessage(`" + streamId + "`, `" + Convert.ToBase64String(data) + "`)");
            });
        }
    }
}
