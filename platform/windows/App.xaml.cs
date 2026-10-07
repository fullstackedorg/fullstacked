using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.Windows.AppLifecycle;
using System;
using System.Collections.Generic;
using System.IO;
using Windows.ApplicationModel.Activation;

namespace FullStacked
{

    unsafe public partial class App : Application
    {
        public static Core core;
        public static App singleton;
        public static App Singleton => singleton;
        public static DispatcherQueue dispatcherQueue;

        private readonly Dictionary<byte, WebView> webviews = new();
        private string appDataFolder;
        private string buildFolder;
        private bool isSafeRunning = false;
        private DateTime lastSafeTriggerTime = DateTime.MinValue;

        public App()
        {
            singleton = this;
            this.InitializeComponent();
        }


        protected override async void OnLaunched(Microsoft.UI.Xaml.LaunchActivatedEventArgs args)
        {
            // Single instance: a second launch (e.g. a fullstacked:// deeplink while the
            // app runs) hands its activation to the running instance and exits.
            AppActivationArguments activation = AppInstance.GetCurrent().GetActivatedEventArgs();
            AppInstance mainInstance = AppInstance.FindOrRegisterForKey("main");
            if (!mainInstance.IsCurrent)
            {
                await mainInstance.RedirectActivationToAsync(activation);
                System.Diagnostics.Process.GetCurrentProcess().Kill();
                return;
            }
            mainInstance.Activated += onActivated;

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

            string launchDeepLink = getDeepLink(activation);
            if (launchDeepLink != null)
            {
                this.deepLink(launchDeepLink);
            }
        }

        private static string getDeepLink(AppActivationArguments activation)
        {
            if (activation.Kind == ExtendedActivationKind.Protocol &&
                activation.Data is IProtocolActivatedEventArgs protocolArgs)
            {
                return protocolArgs.Uri.AbsoluteUri;
            }
            return null;
        }

        // Activation redirected from another launch of the app
        private void onActivated(object sender, AppActivationArguments activation)
        {
            string url = getDeepLink(activation);
            if (url != null)
            {
                this.deepLink(url);
            }
        }

        // A deeplink comes from the outside: trigger it in every context we manage.
        public void deepLink(string url)
        {
            if (dispatcherQueue != null && !dispatcherQueue.HasThreadAccess)
            {
                dispatcherQueue.TryEnqueue(() => deepLink(url));
                return;
            }

            foreach (byte ctx in new List<byte>(this.webviews.Keys))
            {
                core.deepLink(ctx, url);
            }
        }

        public void Safe()
        {
            if (dispatcherQueue != null && !dispatcherQueue.HasThreadAccess)
            {
                dispatcherQueue.TryEnqueue(() => Safe());
                return;
            }

            if (isSafeRunning) return;
            if (DateTime.UtcNow - lastSafeTriggerTime < TimeSpan.FromSeconds(1)) return;
            lastSafeTriggerTime = DateTime.UtcNow;
            isSafeRunning = true;
            try
            {
                var activeWebviews = new List<WebView>(this.webviews.Values);

                byte safeCtx = core.startSafe(appDataFolder, buildFolder);
                this.open(safeCtx);

                foreach (var wv in activeWebviews)
                {
                    if (wv.GetCtx() == safeCtx) continue;
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

                if (this.webviews.TryGetValue(safeCtx, out var safeWebview))
                {
                    safeWebview.Activate();
                }
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
