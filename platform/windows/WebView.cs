using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Windows.Storage.Streams;
using WinRT.Interop;

namespace FullStacked
{
    internal partial class WebView : Window
    {
        private byte ctx;
        private WebView2 webview = new();

        private Window authWindow = null;
        private WebView2 authWebView = null;
        private bool authResolved = false;

        private static byte[] notFoundPayload = Encoding.UTF8.GetBytes("Not Found");

        private readonly object syncLock = new();
        private Dictionary<byte, TaskCompletionSource<byte[]>> syncAwaitersResolve = [];
        private Dictionary<byte, byte[]> syncAwaitersPayload = [];
        private bool skipInitialDir = false;

        private const uint WM_HOTKEY = 0x0312;
        private const uint MOD_CONTROL = 0x0002;
        private const uint MOD_SHIFT = 0x0004;
        private const uint MOD_NOREPEAT = 0x4000;
        private const int HOTKEY_PANIC_T = 9001;
        private const int HOTKEY_PANIC_ESC = 9002;

        private IntPtr hwnd = IntPtr.Zero;
        private SubclassProc subclassProc;
        private bool hotkeysRegistered = false;

        private delegate IntPtr SubclassProc(IntPtr hWnd, uint uMsg, IntPtr wParam, IntPtr lParam, UIntPtr uIdSubclass, UIntPtr dwRefData);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [DllImport("comctl32.dll", SetLastError = true)]
        private static extern bool SetWindowSubclass(IntPtr hWnd, SubclassProc pfnSubclass, UIntPtr uIdSubclass, UIntPtr dwRefData);

        [DllImport("comctl32.dll", SetLastError = true)]
        private static extern bool RemoveWindowSubclass(IntPtr hWnd, SubclassProc pfnSubclass, UIntPtr uIdSubclass);

        [DllImport("comctl32.dll")]
        private static extern IntPtr DefSubclassProc(IntPtr hWnd, uint uMsg, IntPtr wParam, IntPtr lParam);

        public WebView(byte ctx, bool isInitialDir = false, bool skipInitialDir = false)
        {
            this.ctx = ctx;
            this.skipInitialDir = skipInitialDir;

            this.Title = "FullStacked";
            this.AppWindow.SetIcon("Assets/Window-Icon.ico");

            this.hwnd = WindowNative.GetWindowHandle(this);
            this.subclassProc = new SubclassProc(this.WindowSubclass);
            SetWindowSubclass(this.hwnd, this.subclassProc, (UIntPtr)1, UIntPtr.Zero);
            this.RegisterHotKeys();

            this.Activated += (sender, args) =>
            {
                if (args.WindowActivationState == WindowActivationState.Deactivated)
                {
                    this.UnregisterHotKeys();
                }
                else
                {
                    this.RegisterHotKeys();
                }
            };

            this.Closed += (sender, args) =>
            {
                this.UnregisterHotKeys();
                if (this.hwnd != IntPtr.Zero && this.subclassProc != null)
                {
                    RemoveWindowSubclass(this.hwnd, this.subclassProc, (UIntPtr)1);
                }
                this.CancelAuth();
            };

            if (isInitialDir)
            {
                string savedSize = App.singleton?.GetConfig(ctx, "windowSize");
                if (!string.IsNullOrWhiteSpace(savedSize))
                {
                    this.ApplyWindowSize(savedSize);
                }
            }
            else
            {
                this.ApplyWindowSize("700:550");
            }

            this.InitWebView();

            this.Content = this.webview;
            this.Activate();
        }

        public void ApplyWindowSize(string sizeVal)
        {
            if (string.IsNullOrWhiteSpace(sizeVal))
            {
                return;
            }

            sizeVal = sizeVal.Trim();
            if (sizeVal == "kiosk")
            {
                this.AppWindow.SetPresenter(Microsoft.UI.Windowing.AppWindowPresenterKind.FullScreen);
            }
            else if (sizeVal == "fullscreen")
            {
                this.AppWindow.SetPresenter(Microsoft.UI.Windowing.AppWindowPresenterKind.Default);
                var overlappedPresenter = this.AppWindow.Presenter as Microsoft.UI.Windowing.OverlappedPresenter;
                if (overlappedPresenter != null)
                {
                    overlappedPresenter.Maximize();
                }
            }
            else
            {
                string[] parts = sizeVal.Split(':');
                if (parts.Length >= 2)
                {
                    int w = int.Parse(parts[0]);
                    int h = int.Parse(parts[1]);

                    if (this.AppWindow.Presenter.Kind == Microsoft.UI.Windowing.AppWindowPresenterKind.FullScreen)
                    {
                        this.AppWindow.SetPresenter(Microsoft.UI.Windowing.AppWindowPresenterKind.Default);
                    }
                    var overlappedPresenter = this.AppWindow.Presenter as Microsoft.UI.Windowing.OverlappedPresenter;
                    if (overlappedPresenter != null && overlappedPresenter.State == Microsoft.UI.Windowing.OverlappedPresenterState.Maximized)
                    {
                        overlappedPresenter.Restore();
                    }

                    if (parts.Length == 4)
                    {
                        int x = int.Parse(parts[2]);
                        int y = int.Parse(parts[3]);
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
                }
            }
        }

        async public void InitWebView()
        {
            try
            {
                await this.webview.EnsureCoreWebView2Async();

                await this.webview.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(@"
                    window.addEventListener('keydown', (e) => {
                        const isCtrl = e.ctrlKey || e.metaKey;
                        const isShift = e.shiftKey;
                        if (isCtrl && isShift && (e.code === 'KeyT' || e.key === 't' || e.key === 'T' || e.code === 'Escape' || e.key === 'Escape')) {
                            e.preventDefault();
                            e.stopPropagation();
                            window.chrome.webview.postMessage('panic_recovery');
                        }
                    }, true);
                ");

                this.webview.CoreWebView2.WebMessageReceived += delegate (CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
                {
                    string base64 = args.TryGetWebMessageAsString();
                    if (base64 == "panic_recovery")
                    {
                        this.DispatcherQueue.TryEnqueue(() => App.singleton?.PanicRecovery());
                        return;
                    }
                    byte[] data = Convert.FromBase64String(base64);
                    byte[] response = App.core.call(data);


                byte id = data[1];

                // Sync
                if (data[4] == 1)
                {
                    lock (this.syncLock)
                    {
                        if (this.syncAwaitersResolve.ContainsKey(id))
                        {
                            this.syncAwaitersResolve[id].SetResult(response);
                        }
                        else
                        {
                            this.syncAwaitersPayload[id] = response;
                        }
                    }
                }
                // Async
                else
                {
                    _ = this.webview.CoreWebView2.ExecuteScriptAsync("window.fullstacked.respond(" + id + ",`" + Convert.ToBase64String(response) + "`)");
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


                    byte[] cachedPayload = null;
                    lock (this.syncLock)
                    {
                        if (this.syncAwaitersPayload.ContainsKey(id))
                        {
                            cachedPayload = this.syncAwaitersPayload[id];
                            this.syncAwaitersPayload.Remove(id);
                        }
                    }

                    if (cachedPayload != null)
                    {
                        sendCallback(cachedPayload);
                    }
                    else
                    {
                        using (args.GetDeferral())
                        {
                            TaskCompletionSource<byte[]> resolve = new(TaskCreationOptions.RunContinuationsAsynchronously);
                            lock (this.syncLock)
                            {
                                this.syncAwaitersResolve[id] = resolve;
                            }

                            byte[] awaitedPayload = await resolve.Task;

                            lock (this.syncLock)
                            {
                                this.syncAwaitersResolve.Remove(id);
                            }

                            sendCallback(awaitedPayload);
                        }
                    }

                    return;
                } else if (pathname.StartsWith("/resize")) {
                    var queryParams = this.parseQueryParams(uri);

                    using (args.GetDeferral())
                    {
                        TaskCompletionSource<byte[]> resizeTcs = new(TaskCreationOptions.RunContinuationsAsynchronously);
                        byte[] responseBuffer = [];

                        this.DispatcherQueue.TryEnqueue(() =>
                        {
                            try
                            {
                                if (queryParams.TryGetValue("size", out string sizeVal) && !string.IsNullOrEmpty(sizeVal))
                                {
                                    this.ApplyWindowSize(sizeVal);
                                    responseBuffer = [];
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

                                    responseBuffer = Encoding.UTF8.GetBytes(responseStr);
                                }
                            }
                            catch (Exception ex)
                            {
                                System.Diagnostics.Debug.WriteLine($"Error during resize operation: {ex}");
                            }
                            finally
                            {
                                resizeTcs.SetResult(responseBuffer);
                            }
                        });

                        byte[] resData = await resizeTcs.Task;
                        (stream, headers) = this.bufferToResponseStream(resData);
                        args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    }
                    return;
                } else if (pathname.StartsWith("/open")) {
                    var queryParams = this.parseQueryParams(uri);
                    
                    
                    if (queryParams.TryGetValue("ctx", out string ctxVal) && !string.IsNullOrEmpty(ctxVal))
                    {
                        byte ctxId = byte.Parse(ctxVal);
                        App.singleton.open(ctxId);
                    }

                    (stream, headers) = this.bufferToResponseStream(new byte[] {});
                    args.Response = this.webview.CoreWebView2.Environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    return;
                }else if (pathname.StartsWith("/exit")) {
                    this.DispatcherQueue.TryEnqueue(() => this.Close());
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

            this.webview.CoreWebView2.NewWindowRequested += async delegate (CoreWebView2 sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                bool isAuth = false;
                try
                {
                    Uri uri = new(e.Uri);
                    isAuth = uri.Query.Contains("auth") || uri.PathAndQuery.Contains("auth");
                }
                catch
                {
                    isAuth = e.Uri != null && e.Uri.Contains("auth");
                }

                if (isAuth)
                {
                    var deferral = e.GetDeferral();
                    try
                    {
                        this.CloseAuthWindow();
                        this.authResolved = false;

                        this.authWindow = new Window();
                        this.authWindow.Title = "Authentication";
                        this.authWindow.AppWindow.SetIcon("Assets/Window-Icon.ico");

                        int parentW = this.AppWindow.Size.Width;
                        int parentH = this.AppWindow.Size.Height;
                        int parentX = this.AppWindow.Position.X;
                        int parentY = this.AppWindow.Position.Y;
                        int authW = 500;
                        int authH = 600;
                        if (e.WindowFeatures != null && e.WindowFeatures.HasSize && e.WindowFeatures.Width > 0 && e.WindowFeatures.Height > 0)
                        {
                            authW = (int)e.WindowFeatures.Width;
                            authH = (int)e.WindowFeatures.Height;
                        }
                        int authX = parentX + Math.Max(0, (parentW - authW) / 2);
                        int authY = parentY + Math.Max(0, (parentH - authH) / 2);
                        this.authWindow.AppWindow.MoveAndResize(new Windows.Graphics.RectInt32(authX, authY, authW, authH));

                        this.authWebView = new WebView2();
                        this.authWindow.Content = this.authWebView;

                        this.authWindow.AppWindow.Closing += delegate (Microsoft.UI.Windowing.AppWindow s, Microsoft.UI.Windowing.AppWindowClosingEventArgs args)
                        {
                            this.CancelAuth();
                        };

                        this.authWindow.Closed += delegate (object s, WindowEventArgs args)
                        {
                            this.CancelAuth();
                        };

                        await this.authWebView.EnsureCoreWebView2Async(this.webview.CoreWebView2.Environment);

                        this.authWebView.CoreWebView2.WindowCloseRequested += delegate (CoreWebView2 s, object args)
                        {
                            this.CancelAuth();
                        };

                        this.authWebView.CoreWebView2.NavigationStarting += delegate (CoreWebView2 s, CoreWebView2NavigationStartingEventArgs navArgs)
                        {
                            string navUri = navArgs.Uri;
                            if (navUri.StartsWith("fullstacked://") || navUri.StartsWith("fullstacked-auth://") || navUri.StartsWith("fullstacked-ctx://"))
                            {
                                navArgs.Cancel = true;
                                this.ResolveAuth(navUri);
                            }
                            else if ((navUri.Contains("localhost") || navUri.Contains("127.0.0.1")) &&
                                     (navUri.Contains("code=") || navUri.Contains("token=") || navUri.Contains("access_token=")))
                            {
                                navArgs.Cancel = true;
                                this.ResolveAuth(navUri);
                            }
                        };

                        await this.authWebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(@"
                            window.opener = window.opener || {};
                            const origPost = window.opener.postMessage ? window.opener.postMessage.bind(window.opener) : null;
                            window.opener.postMessage = function(data) {
                                var q = (data && typeof data === 'object') ? new URLSearchParams(data).toString() : String(data);
                                location.href = 'fullstacked://auth?' + q;
                                if (origPost) {
                                    try { origPost(data, '*'); } catch(e) {}
                                }
                            };
                            var origClose = window.close;
                            window.close = function() {
                                if (origClose) {
                                    try { origClose.apply(window, arguments); } catch(e) {}
                                }
                            };
                        ");

                        e.NewWindow = this.authWebView.CoreWebView2;
                        e.Handled = true;
                        this.authWindow.Activate();
                    }
                    catch (Exception ex)
                    {
                        System.Diagnostics.Debug.WriteLine($"Error creating auth window: {ex}");
                        this.CancelAuth();
                    }
                    finally
                    {
                        deferral.Complete();
                    }
                    return;
                }

                e.Handled = true;
                try
                {
                    Uri extUrl = new(e.Uri);
                    _ = Windows.System.Launcher.LaunchUriAsync(extUrl);
                }
                catch (Exception ex)
                {
                    System.Diagnostics.Debug.WriteLine($"Error launching uri: {ex}");
                }
            };

            this.webview.Source = new Uri(this.skipInitialDir ? "http://localhost?skipInitialDir=true" : "http://localhost");
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Error in InitWebView: {ex}");
            }
        }

        private void CancelAuth()
        {
            if (this.authResolved) return;
            this.authResolved = true;

            this.DispatcherQueue.TryEnqueue(() =>
            {
                if (this.webview?.CoreWebView2 != null)
                {
                    _ = this.webview.CoreWebView2.ExecuteScriptAsync(@"
                        try {
                            const err = new Error('Authentication Canceled');
                            window.dispatchEvent(new MessageEvent('message', { data: err }));
                            window.postMessage(err, '*');
                        } catch (e) {
                            window.postMessage(new Error('Authentication Canceled'), '*');
                        }
                    ");
                }
                this.CloseAuthWindow();
            });
        }

        private void ResolveAuth(string uri)
        {
            if (this.authResolved) return;
            this.authResolved = true;

            Uri callbackUri = new(uri);
            string query = callbackUri.Query.TrimStart('?');
            if (string.IsNullOrEmpty(query) && !string.IsNullOrEmpty(callbackUri.Fragment))
            {
                query = callbackUri.Fragment.TrimStart('#');
            }

            this.DispatcherQueue.TryEnqueue(() =>
            {
                if (this.webview?.CoreWebView2 != null)
                {
                    _ = this.webview.CoreWebView2.ExecuteScriptAsync($@"
                        try {{
                            const data = Object.fromEntries(new URLSearchParams(`{query}`));
                            window.dispatchEvent(new MessageEvent('message', {{ data }}));
                            window.postMessage(data, '*');
                        }} catch (e) {{
                            window.postMessage(Object.fromEntries(new URLSearchParams(`{query}`)), '*');
                        }}
                    ");
                }
                this.CloseAuthWindow();
            });
        }

        private void CloseAuthWindow()
        {
            if (this.authWindow != null)
            {
                var win = this.authWindow;
                this.authWindow = null;
                this.authWebView = null;
                try
                {
                    win.Close();
                }
                catch { }
            }
        }

        public void onStreamData(byte streamId, byte[] data)
        {
            this.DispatcherQueue.TryEnqueue(DispatcherQueuePriority.High, () =>
            {
                if (this.webview?.CoreWebView2 != null)
                {
                    _ = this.webview.CoreWebView2.ExecuteScriptAsync("window.fullstacked.onStreamData(" + streamId + ", `" + Convert.ToBase64String(data) + "`)");
                }
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

        private Dictionary<string, string> parseQueryParams(Uri uri)
        {
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
            return queryParams;
        }

        private void RegisterHotKeys()
        {
            if (this.hwnd == IntPtr.Zero || this.hotkeysRegistered) return;
            RegisterHotKey(this.hwnd, HOTKEY_PANIC_T, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, (uint)Windows.System.VirtualKey.T);
            RegisterHotKey(this.hwnd, HOTKEY_PANIC_ESC, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, (uint)Windows.System.VirtualKey.Escape);
            this.hotkeysRegistered = true;
        }

        public void UnregisterHotKeys()
        {
            if (this.hwnd == IntPtr.Zero || !this.hotkeysRegistered) return;
            UnregisterHotKey(this.hwnd, HOTKEY_PANIC_T);
            UnregisterHotKey(this.hwnd, HOTKEY_PANIC_ESC);
            this.hotkeysRegistered = false;
        }

        private IntPtr WindowSubclass(IntPtr hWnd, uint uMsg, IntPtr wParam, IntPtr lParam, UIntPtr uIdSubclass, UIntPtr dwRefData)
        {
            if (uMsg == WM_HOTKEY)
            {
                int id = wParam.ToInt32();
                if (id == HOTKEY_PANIC_T || id == HOTKEY_PANIC_ESC)
                {
                    App.singleton.PanicRecovery();
                    return IntPtr.Zero;
                }
            }
            return DefSubclassProc(hWnd, uMsg, wParam, lParam);
        }
    }
}
