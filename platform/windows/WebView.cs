﻿using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using System;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web;
using Windows.Storage.Streams;

namespace FullStacked
{
    internal class WebView
    {
        public WebView2 webview;
        public Instance instance;
        private bool firstContact = false;
        private List<(string, string)> messageToBeSent = [];

        public WebView(Instance instance)
        {
            this.instance = instance;
            this.webview = new WebView2();
            this.Init();
        }

        async public void Init()
        {
            await this.webview.EnsureCoreWebView2Async();
            this.webview.CoreWebView2.WebMessageReceived += delegate (CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
            {
                if (!this.firstContact) {
                    this.firstContact = true;
                    foreach (var item in this.messageToBeSent)
                    {
                        this.onMessage(item.Item1, item.Item2);
                    }
                    this.messageToBeSent.Clear();
                }
                string base64 = args.TryGetWebMessageAsString();
                byte[] data = Convert.FromBase64String(base64);
                byte[] id = data[new Range(0, 4)];
                byte[] payload = data[new Range(4, data.Length)];
                byte[] libResponse = this.instance.callLib(payload);
                byte[] response = App.combineBuffers([id, libResponse]);
                _ = this.webview.CoreWebView2.ExecuteScriptAsync("window.respond(`" + Convert.ToBase64String(response) + "`)");
            };
            this.webview.CoreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            this.webview.CoreWebView2.WebResourceRequested += delegate (CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args)
            {
                Uri uri = new(args.Request.Uri);

                if (uri.Host != "localhost") {
                    return;
                }

                String pathname = uri.LocalPath;

                if (pathname == "/platform")
                {
                    byte[] platformData = Encoding.UTF8.GetBytes("windows");
                    IRandomAccessStream stream = new MemoryStream(platformData).AsRandomAccessStream();
                    string[] headersPlatform = {
                        "Content-Type: text/html",
                        "Content-Length: " + platformData.Length
                    };
                    args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", string.Join("\r\n", headersPlatform));
                    return;
                }
                else if (pathname == "/call-sync")
                {
                    NameValueCollection queryDictionary = HttpUtility.ParseQueryString(uri.Query);
                    byte[] syncPayload = Convert.FromBase64String(HttpUtility.UrlDecode(queryDictionary.Get("payload")));
                    byte[] libResponse = this.instance.callLib(syncPayload);
                    IRandomAccessStream syncResStream = new MemoryStream(libResponse).AsRandomAccessStream();
                    string[] headersSync = {
                        "Content-Type: application/octet-stream",
                        "Content-Length: " + libResponse.Length,
                        "Cache-Control: no-cache"
                    };
                    args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(
                        syncResStream,
                        200,
                        "OK",
                        string.Join("\r\n", headersSync)
                    );
                    return;
                }

                // static file serving


                byte[] header = new byte[] {
                    1, // Static File Serving
                    2  // STRING
                };

                byte[] pathnameData = Encoding.UTF8.GetBytes(pathname);
                byte[] pathnameLength = App.numberToByte(pathnameData.Length);
                byte[] payload = App.combineBuffers([header, pathnameLength, pathnameData]);

                byte[] response = this.instance.callLib(payload);

                List<DataValue> values = App.deserializeArgs(response);

                if (values.Count == 0)
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

            this.webview.Source = new Uri("http://localhost");
        }

        private void CoreWebView2_NewWindowRequested(CoreWebView2 sender, CoreWebView2NewWindowRequestedEventArgs args)
        {
            throw new NotImplementedException();
        }

        public void onMessage(string type, string message) {
            if (!this.firstContact) {
                this.messageToBeSent.Add((type, message));
                return;
            }
            this.webview.DispatcherQueue.TryEnqueue(DispatcherQueuePriority.High, () =>
            {
                _ = this.webview.CoreWebView2.ExecuteScriptAsync("window.oncoremessage(`" + type + "`, `" + message + "`)");
            });
        }
    }
}
