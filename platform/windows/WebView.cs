using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Web.WebView2.Core;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Storage.Streams;

namespace FullStacked
{
    internal partial class WebView : Window
    {
        private byte ctx;
        public byte GetCtx() => this.ctx;

        // Delivers an auth result (query of fullstacked-auth://auth?...) to the page, like the
        // auth window of the other platforms
        public void postAuthResult(string query)
        {
            string escaped = query.Replace("\\", "\\\\").Replace("`", "\\`");
            _ = this.coreWebView2?.ExecuteScriptAsync(
                "window.postMessage(Object.fromEntries(new URLSearchParams(`" + escaped + "`)), \"*\")");
        }
        private CoreWebView2Controller controller;
        // held for the lifetime of the window: CsWinRT drops the event handlers of a
        // collected projection, so once the GC runs WebResourceRequested stops firing
        // (requests fall through to the network) or crashes with an AccessViolation
        private CoreWebView2 coreWebView2;
        private CoreWebView2Environment environment;
        private bool isClosed = false;

        private static readonly object envLock = new();
        private static Task<CoreWebView2Environment> sharedEnvironmentTask;
        private static Task<CoreWebView2Environment> GetEnvironmentAsync()
        {
            lock (envLock)
            {
                if (sharedEnvironmentTask == null || sharedEnvironmentTask.IsFaulted)
                {
                    sharedEnvironmentTask = CoreWebView2Environment.CreateAsync().AsTask();
                }
                return sharedEnvironmentTask;
            }
        }

        private static byte[] notFoundPayload = Encoding.UTF8.GetBytes("Not Found");

        // core calls of this webview run in order, off the UI thread
        private readonly object coreQueueLock = new();
        private Task coreQueue = Task.CompletedTask;

        // responses and stream chunks received between two UI thread ticks are
        // evaluated in one script
        private readonly object scriptLock = new();
        private StringBuilder pendingScript = new();
        private bool scriptFlushScheduled = false;

        // captured on the UI thread, used to get back to it from core threads
        private readonly DispatcherQueue uiQueue;

        // reader generation of the stream frames posted to the page, UI thread only
        private int frameStreamGen = -1;

        public WebView(byte ctx)
        {
            this.ctx = ctx;
            this.uiQueue = this.DispatcherQueue;

            this.Title = "FullStacked";
            this.AppWindow.SetIcon("Assets/Window-Icon.ico");

            this.AppWindow.Changed += delegate (Microsoft.UI.Windowing.AppWindow sender, Microsoft.UI.Windowing.AppWindowChangedEventArgs args)
            {
                if (args.DidPositionChange)
                {
                    this.controller?.NotifyParentWindowPositionChanged();
                }
                if (args.DidSizeChange)
                {
                    this.UpdateBounds();
                }
            };

            this.SizeChanged += delegate (object sender, WindowSizeChangedEventArgs args)
            {
                this.UpdateBounds();
            };

            this.Activated += delegate (object sender, WindowActivatedEventArgs args)
            {
                if (args.WindowActivationState != WindowActivationState.Deactivated)
                {
                    App.singleton.lastActiveCtx = this.ctx;
                    this.controller?.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
                }
            };

            this.Closed += delegate (object sender, WindowEventArgs args)
            {
                this.isClosed = true;
                this.stopFrameStream();
                this.controller?.Close();
                this.controller = null;
                this.coreWebView2 = null;
            };

            this.InitWebView();

            this.Activate();
        }

        private const uint SWP_NOSIZE = 0x0001;
        private const uint SWP_NOMOVE = 0x0002;
        private const uint SWP_NOACTIVATE = 0x0010;
        private const uint SWP_SHOWWINDOW = 0x0040;

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool EnumChildWindows(IntPtr hWndParent, EnumChildProc lpEnumFunc, IntPtr lParam);

        private delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);

        [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct RECT { public int Left, Top, Right, Bottom; }

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern short GetKeyState(int nVirtKey);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern short GetAsyncKeyState(int nVirtKey);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern bool EnableWindow(IntPtr hWnd, bool bEnable);

        [System.Runtime.InteropServices.DllImport("user32.dll")]
        private static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        private void EnsureChildOnTop()
        {
            try
            {
                IntPtr hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
                EnumChildWindows(hwnd, (childHwnd, lParam) =>
                {
                    var sb = new StringBuilder(256);
                    GetClassName(childHwnd, sb, 256);
                    string className = sb.ToString();
                    if (className.Contains("DesktopChildSiteBridge") || className.Contains("InputSiteWindowClass"))
                    {
                        EnableWindow(childHwnd, false);
                        int exStyle = GetWindowLong(childHwnd, -20);
                        SetWindowLong(childHwnd, -20, exStyle | 0x00000020 /* WS_EX_TRANSPARENT */);
                        SetWindowPos(childHwnd, (IntPtr)1 /* HWND_BOTTOM */, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                    }
                    else if (className.StartsWith("Chrome_WidgetWin_0"))
                    {
                        SetWindowPos(childHwnd, IntPtr.Zero /* HWND_TOP */, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
                    }
                    return true;
                }, IntPtr.Zero);
            }
            catch { }
        }

        private void UpdateBounds()
        {
            if (this.controller == null) return;

            var clientSize = this.AppWindow.ClientSize;
            if (clientSize.Width > 0 && clientSize.Height > 0)
            {
                this.controller.IsVisible = true;
                this.controller.Bounds = new Windows.Foundation.Rect(0, 0, clientSize.Width, clientSize.Height);
                this.EnsureChildOnTop();
            }
            else
            {
                this.controller.IsVisible = false;
            }
        }

        async public void InitWebView()
        {
            try
            {
                this.environment = await GetEnvironmentAsync();
                if (this.isClosed) return;

                IntPtr hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
                var windowRef = CoreWebView2ControllerWindowReference.CreateFromWindowHandle((ulong)(nint)hwnd);

                this.controller = await this.environment.CreateCoreWebView2ControllerAsync(windowRef);
                if (this.isClosed)
                {
                    this.controller?.Close();
                    this.controller = null;
                    return;
                }

                this.controller.BoundsMode = CoreWebView2BoundsMode.UseRawPixels;
                this.UpdateBounds();
                this.controller.IsVisible = true;
                this.EnsureChildOnTop();
                this.controller.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);

                this.controller.AcceleratorKeyPressed += delegate (CoreWebView2Controller sender, CoreWebView2AcceleratorKeyPressedEventArgs e)
                {
                    if (e.KeyEventKind == CoreWebView2KeyEventKind.KeyDown || e.KeyEventKind == CoreWebView2KeyEventKind.SystemKeyDown)
                    {
                        if (e.VirtualKey == (uint)Windows.System.VirtualKey.T)
                        {
                            bool isCtrl = (GetKeyState(0x11) & 0x8000) != 0 || (GetAsyncKeyState(0x11) & 0x8000) != 0;
                            bool isShift = (GetKeyState(0x10) & 0x8000) != 0 || (GetAsyncKeyState(0x10) & 0x8000) != 0;
                            if (isCtrl && isShift)
                            {
                                e.Handled = true;
                                this.DispatcherQueue.TryEnqueue(() => App.Singleton.Safe());
                            }
                        }
                    }
                };

                var coreWebView2 = this.coreWebView2 = this.controller.CoreWebView2;

            coreWebView2.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            coreWebView2.WebResourceRequested += async delegate (CoreWebView2 sender, CoreWebView2WebResourceRequestedEventArgs args)
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
                    args.Response = this.environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    return;
                }
                else if (pathname == "/ctx")
                {
                    byte[] ctxBuffer = Encoding.UTF8.GetBytes(this.ctx.ToString());
                    (stream, headers) = this.bufferToResponseStream(ctxBuffer);
                    args.Response = this.environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    return;
                }
                else if (pathname == "/stream")
                {
                    this.startFrameStream();
                    (stream, headers) = this.bufferToResponseStream([]);
                    args.Response = this.environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    return;
                }
                else if (pathname == "/stream/detach")
                {
                    this.stopFrameStream();
                    (stream, headers) = this.bufferToResponseStream([]);
                    args.Response = this.environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    return;
                }
                else if (pathname == "/bridge")
                {
                    // the page posts its calls to /call and /sync
                    (stream, headers) = this.bufferToResponseStream(Encoding.UTF8.GetBytes("binary"));
                    args.Response = this.environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    return;
                }
                else if (pathname == "/call" || pathname == "/sync")
                {
                    // the body is the payload, the response the core response; sync is
                    // a sync XHR of the page, the same for the host
                    using (args.GetDeferral())
                    {
                        byte[] body = await readRequestBody(args.Request);
                        byte[] response = await this.enqueueCoreCall(body);
                        (stream, headers) = this.bufferToResponseStream(response, "application/octet-stream");
                        args.Response = this.environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    }
                    return;
                }
                else if (pathname.StartsWith("/resize")) {
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
                        args.Response = this.environment.CreateWebResourceResponse(stream, 200, "OK", headers);
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
                    args.Response = this.environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                    return;
                } else if (pathname.StartsWith("/exit")) {
                    this.DispatcherQueue.TryEnqueue(() => this.Close());
                    return;
                }

                // static file serving, read off the UI thread, respond on it

                byte[] header = [
                    this.ctx,
                    0, // req id, unused by callWithResponse
                    0, // Core Module
                    0, // Fn Static File
                    0, // Async
                    
                    ((byte)SerializableDataType.STRING),
                ];

                byte[] pathnameData = Encoding.UTF8.GetBytes(pathname);
                byte[] pathnameLength = Serialization.NumberToUint4Bytes(pathnameData.Length);
                byte[] payload = Serialization.MergeBuffers([header, pathnameLength, pathnameData]);

                using (args.GetDeferral())
                {
                    List<DataValue> values = await Task.Run(() =>
                    {
                        byte[] response = App.core.call(payload);
                        if (response.Length <= 1)
                        {
                            return new List<DataValue>();
                        }
                        (DataValue argBuffer, _) = Serialization.Deserialize(response, 1);
                        return Serialization.DeserializeAll(argBuffer.buffer);
                    });

                    if (values.Count < 2)
                    {
                        (stream, headers) = this.bufferToResponseStream(WebView.notFoundPayload);
                        args.Response = this.environment.CreateWebResourceResponse(stream, 404, "OK", headers);
                        return;
                    }

                    (stream, headers) = this.bufferToResponseStream(values[1].buffer, values[0].str);
                    args.Response = this.environment.CreateWebResourceResponse(stream, 200, "OK", headers);
                }
            };

            coreWebView2.NewWindowRequested += delegate (CoreWebView2 sender, CoreWebView2NewWindowRequestedEventArgs e)
            {
                Uri url = new(e.Uri);
                if (url.Query.Contains("auth")) {
                    return;
                }

                e.Handled = true;
                _ = Windows.System.Launcher.LaunchUriAsync(url);
            };

            coreWebView2.Navigate("http://localhost");
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine($"Error initializing WebView2: {ex}");
        }
    }

    // calls of this webview run in order on the core queue, off the UI thread
    private Task<byte[]> enqueueCoreCall(byte[] payload)
    {
        lock (this.coreQueueLock)
        {
            Task<byte[]> call = this.coreQueue.ContinueWith(_ => App.core.call(payload), TaskScheduler.Default);
            this.coreQueue = call;
            return call;
        }
    }

    private static async Task<byte[]> readRequestBody(CoreWebView2WebResourceRequest request)
    {
        IRandomAccessStream content = request.Content;
        if (content == null)
        {
            return [];
        }
        using Stream body = content.AsStreamForRead();
        using MemoryStream buffer = new();
        await body.CopyToAsync(buffer);
        return buffer.ToArray();
    }

    public void onStreamData(byte streamId, byte[] data)
    {
        this.queueScript("window.fullstacked.onStreamData(" + streamId + ", `" + Convert.ToBase64String(data) + "`)");
    }

    // a statement that throws does not stop the others of the batch
    private void queueScript(string statement)
    {
        bool schedule;
        lock (this.scriptLock)
        {
            this.pendingScript.Append("try{").Append(statement).Append("}catch(e){console.error(e)};");
            schedule = !this.scriptFlushScheduled;
            this.scriptFlushScheduled = true;
        }

        if (schedule)
        {
            this.uiQueue.TryEnqueue(DispatcherQueuePriority.High, this.flushScripts);
        }
    }

    private void flushScripts()
    {
        string script;
        lock (this.scriptLock)
        {
            script = this.pendingScript.ToString();
            this.pendingScript.Clear();
            this.scriptFlushScheduled = false;
        }

        if (script.Length > 0 && this.coreWebView2 != null)
        {
            _ = this.coreWebView2.ExecuteScriptAsync(script);
        }
    }

        // Stream data of the context as binary frames (see core/internal/frames). WebView2
        // reads a response stream entirely before answering, so the frames are posted to
        // the page in shared buffers instead (bridge/frames.ts readFrameSharedBuffers).
        // A thread reads them from the core until the context ends or the page reloads.
        private void startFrameStream()
        {
            this.stopFrameStream();

            byte ctx = this.ctx;
            int gen = App.core.streamAttach(ctx);
            if (gen < 0)
            {
                return;
            }
            this.frameStreamGen = gen;

            Thread reader = new(() =>
            {
                while (true)
                {
                    byte[] frames = App.core.streamRead(ctx, gen);
                    if (frames == null)
                    {
                        break;
                    }
                    this.uiQueue.TryEnqueue(() => this.postFrames(gen, frames));
                }
            })
            {
                IsBackground = true,
                Name = "FullStacked stream frames"
            };
            reader.Start();
        }

        private void stopFrameStream()
        {
            if (this.frameStreamGen < 0)
            {
                return;
            }
            App.core.streamDetach(this.ctx, this.frameStreamGen);
            this.frameStreamGen = -1;
        }

        private void postFrames(int gen, byte[] frames)
        {
            if (gen != this.frameStreamGen || this.coreWebView2 == null || this.environment == null)
            {
                return;
            }

            try
            {
                // closing on this side does not affect the access of the page
                using CoreWebView2SharedBuffer sharedBuffer = this.environment.CreateSharedBuffer((ulong)frames.Length);
                // OpenStream is a WinRT stream, unbuffered adapter so the frames are written once
                using (Stream stream = sharedBuffer.OpenStream().AsStreamForWrite(0))
                {
                    stream.Write(frames, 0, frames.Length);
                }
                this.coreWebView2.PostSharedBufferToScript(sharedBuffer, CoreWebView2SharedBufferAccess.ReadOnly, "{\"type\":\"frames\"}");
            }
            catch (Exception ex)
            {
                System.Diagnostics.Debug.WriteLine($"Error posting stream frames: {ex}");
            }
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
    }
}
