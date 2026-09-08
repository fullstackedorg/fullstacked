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
            string appDataFolder = Path.Combine(localAppData, "fullstacked");
            if (!Directory.Exists(appDataFolder))
            {
                Directory.CreateDirectory(appDataFolder);
            }

            string buildFolder = Path.Combine(Windows.ApplicationModel.Package.Current.InstalledPath, "out");

            var (mainCtx, isInitialDir) = StartMain(appDataFolder, buildFolder, false);
            this.open(mainCtx, isInitialDir, false);
        }

        public string GetConfig(byte ctx, string key)
        {
            byte[] keyBytes = Encoding.UTF8.GetBytes(key);
            byte[] keyLenBytes = Serialization.NumberToUint4Bytes(keyBytes.Length);
            byte[] payload = new byte[6 + 4 + keyBytes.Length];
            payload[0] = ctx;
            payload[1] = 0; // id
            payload[2] = 16; // Config Module
            payload[3] = 0; // Get
            payload[4] = 1; // Sync
            payload[5] = (byte)SerializableDataType.STRING;
            Buffer.BlockCopy(keyLenBytes, 0, payload, 6, 4);
            Buffer.BlockCopy(keyBytes, 0, payload, 10, keyBytes.Length);

            byte[] res = core.call(payload);
            if (res != null && res.Length > 6 && res[0] == 1 && res[1] == (byte)SerializableDataType.STRING)
            {
                var (deserialized, _) = Serialization.Deserialize(res, 1);
                if (!string.IsNullOrWhiteSpace(deserialized?.str))
                {
                    return deserialized.str.Trim();
                }
            }

            return null;
        }

        public (byte ctx, bool isInitialDir) StartMain(string root, string build, bool skipInitialDir = false)
        {
            byte mainCtx = core.start(root, build);
            if (skipInitialDir)
            {
                return (mainCtx, false);
            }

            string initialDir = GetConfig(mainCtx, "initialDirectory");
            if (!string.IsNullOrWhiteSpace(initialDir))
            {
                core.stop(mainCtx);

                string trimmed = initialDir.Trim();
                string subPath = trimmed.StartsWith("/") || trimmed.StartsWith("\\") ? trimmed.Substring(1) : trimmed;
                string targetDir = Path.Combine(root, subPath);
                return (core.start(targetDir, targetDir), true);
            }

            return (mainCtx, false);
        }

        public void open(byte ctx, bool isInitialDir = false, bool skipInitialDir = false)
        {
            if (dispatcherQueue != null && !dispatcherQueue.HasThreadAccess)
            {
                dispatcherQueue.TryEnqueue(() => open(ctx, isInitialDir, skipInitialDir));
                return;
            }

            if (this.webviews.ContainsKey(ctx))
            {
                return;
            }

            WebView webview = new(ctx, isInitialDir, skipInitialDir);
            this.webviews.Add(ctx, webview);
            webview.Closed += delegate (object sender, WindowEventArgs args)
            {
                this.webviews.Remove(ctx);
            };
        }

        public void PanicRecovery()
        {
            if (dispatcherQueue != null && !dispatcherQueue.HasThreadAccess)
            {
                dispatcherQueue.TryEnqueue(() => PanicRecovery());
                return;
            }

            foreach (var kv in new List<KeyValuePair<byte, WebView>>(this.webviews))
            {
                byte ctx = kv.Key;
                kv.Value.Close();
                core.stop(ctx);
            }
            this.webviews.Clear();

            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string appDataFolder = Path.Combine(localAppData, "fullstacked");
            string buildFolder = Path.Combine(Windows.ApplicationModel.Package.Current.InstalledPath, "out");

            var (mainCtx, isInitialDir) = StartMain(appDataFolder, buildFolder, true);
            this.open(mainCtx, false, true);
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
