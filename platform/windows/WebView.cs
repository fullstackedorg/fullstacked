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
        public byte GetCtx() => this.ctx;
        private CoreWebView2Controller controller;
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

        private readonly object syncLock = new();
        private Dictionary<byte, TaskCompletionSource<byte[]>> syncAwaitersResolve = [];
        private Dictionary<byte, byte[]> syncAwaitersPayload = [];

        public WebView(byte ctx)
        {
            this.ctx = ctx;

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
                    this.controller?.MoveFocus(CoreWebView2MoveFocusReason.Programmatic);
                }
            };

            this.Closed += delegate (object sender, WindowEventArgs args)
            {
                this.isClosed = true;
                this.controller?.Close();
                this.controller = null;
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

                var coreWebView2 = this.controller.CoreWebView2;

                coreWebView2.WebMessageReceived += delegate (CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs args)
            {
                string base64 = args.TryGetWebMessageAsString();
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
                    _ = coreWebView2.ExecuteScriptAsync("window.fullstacked.respond(" + id + ",`" + Convert.ToBase64String(response) + "`)");
                }


            };
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
                else if (pathname.StartsWith("/sync"))
                {
                    string idStr = pathname.Split("/").Last();
                    byte id = byte.Parse(idStr);


                    Action<byte[]> sendCallback = (byte[] payload) =>
                    {
                        string b64 = Convert.ToBase64String(payload);
                        byte[] b64Buffer = Encoding.UTF8.GetBytes(b64);
                        (stream, headers) = this.bufferToResponseStream(b64Buffer, "application/octet-stream");
                        args.Response = this.environment.CreateWebResourceResponse(stream, 200, "OK", headers);
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
                    args.Response = this.environment.CreateWebResourceResponse(stream, 404, "OK", headers);
                    return;
                }

                (stream, headers) = this.bufferToResponseStream(values[1].buffer, values[0].str);
                args.Response = this.environment.CreateWebResourceResponse(stream, 200, "OK", headers);
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

    public void onStreamData(byte streamId, byte[] data)
    {
        this.DispatcherQueue.TryEnqueue(DispatcherQueuePriority.High, () =>
        {
            if (this.controller?.CoreWebView2 != null)
            {
                _ = this.controller.CoreWebView2.ExecuteScriptAsync("window.fullstacked.onStreamData(" + streamId + ", `" + Convert.ToBase64String(data) + "`)");
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
    }
}
