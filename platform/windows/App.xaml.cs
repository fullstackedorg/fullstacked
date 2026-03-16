using Microsoft.UI;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using Windows.UI;

namespace FullStacked
{

    unsafe public partial class App : Application
    {
        public static Core core;

        private readonly Dictionary<byte, WebView> webviews = new();

        public App()
        {
            this.InitializeComponent();
        }


        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            core = new(new Core.CoreCallbackDelegate(onStreamData));

            // AppData
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string appDataFolder = Path.Combine(localAppData, "fullstacked");
            Directory.CreateDirectory(appDataFolder);

            string buildFolder = Path.Combine(Windows.ApplicationModel.Package.Current.InstalledPath, "out");

            byte mainCtx = core.start(appDataFolder, buildFolder);
            this.open(mainCtx);
        }

        private void open(byte ctx)
        {
            WebView webview = new(ctx);
            this.webviews.Add(ctx, webview);
            webview.Closed += delegate (object sender, WindowEventArgs args)
            {
                this.webviews.Remove(ctx);
            };
        }

        private void onStreamData(byte ctx, byte streamId, byte[] data)
        {
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