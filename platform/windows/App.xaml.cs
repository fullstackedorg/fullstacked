using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using System;
using System.Collections.Generic;
using System.IO;

namespace FullStacked
{

    unsafe public partial class App : Application
    {
        public static Core core;
        public static App singleton;
        public static DispatcherQueue dispatcherQueue;

        private readonly Dictionary<byte, WebView> webviews = new();
        private string appDataFolder;
        private string buildFolder;
        private bool isSafeRunning = false;

        public App()
        {
            singleton = this;
            this.InitializeComponent();
        }


        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            dispatcherQueue = DispatcherQueue.GetForCurrentThread();

            core = new(new Core.CoreCallbackDelegate(onStreamData));

            // AppData
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            appDataFolder = Path.Combine(localAppData, "fullstacked");
            if (!Directory.Exists(appDataFolder))
            {
                Directory.CreateDirectory(appDataFolder);
            }

            buildFolder = Path.Combine(Windows.ApplicationModel.Package.Current.InstalledPath, "out");

            byte mainCtx = core.start(appDataFolder, buildFolder);
            this.open(mainCtx);
        }

        public void Safe()
        {
            if (dispatcherQueue != null && !dispatcherQueue.HasThreadAccess)
            {
                dispatcherQueue.TryEnqueue(() => Safe());
                return;
            }

            if (isSafeRunning) return;
            isSafeRunning = true;
            try
            {
                var activeWebviews = new List<WebView>(this.webviews.Values);
                this.webviews.Clear();

                foreach (var wv in activeWebviews)
                {
                    try
                    {
                        core.stop(wv.GetCtx());
                    }
                    catch { }
                    try
                    {
                        wv.Close();
                    }
                    catch { }
                }

                byte safeCtx = core.startSafe(appDataFolder, buildFolder);
                this.open(safeCtx);
            }
            finally
            {
                isSafeRunning = false;
            }
        }

        public void open(byte ctx)
        {
            if (dispatcherQueue != null && !dispatcherQueue.HasThreadAccess)
            {
                dispatcherQueue.TryEnqueue(() => open(ctx));
                return;
            }

            if (this.webviews.ContainsKey(ctx))
            {
                return;
            }

            WebView webview = new(ctx);
            this.webviews.Add(ctx, webview);
            webview.Closed += delegate (object sender, WindowEventArgs args)
            {
                this.webviews.Remove(ctx);
            };
        }

        private void onStreamData(byte ctx, byte streamId, byte[] data)
        {
            if (dispatcherQueue != null && !dispatcherQueue.HasThreadAccess)
            {
                dispatcherQueue.TryEnqueue(() => onStreamData(ctx, streamId, data));
                return;
            }

            if (this.webviews.ContainsKey(ctx))
            {
                this.webviews[ctx].onStreamData(streamId, data);
            }
            else
            {
                this.open(ctx);
            }
        }



    }


}
