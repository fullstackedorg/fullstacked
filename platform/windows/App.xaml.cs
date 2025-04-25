﻿using Microsoft.UI.Xaml;
using System.Runtime.InteropServices;
using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using Microsoft.UI;
using Microsoft.UI.Windowing;
using Windows.UI;
using Microsoft.Win32;
using System.Security.Principal;
using System.Reflection;
using Microsoft.UI.Xaml.Input;
using Windows.System;

namespace FullStacked
{

    unsafe public partial class App : Application
    {
        static Lib lib;

        public App()
        {
            switch (RuntimeInformation.ProcessArchitecture)
            {
                case Architecture.X64:
                    App.lib = new LibX64();
                    break;
                case Architecture.X86:
                    App.lib = new LibX86();
                    break;
                case Architecture.Arm64:
                    App.lib = new LibARM64();
                    break;
                default:
                    throw new Exception("Unsupported arch");
            }

            this.InitializeComponent();
            this.registerDeepLinking();
        }

        public static void restartAsAdmin() {
            String directoryLocation = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            var proc = new Process
            {
                StartInfo =
                {
                    FileName = directoryLocation + "\\FullStacked.exe", 
                    UseShellExecute = true, 
                    Verb = "runas"
                }
            };

            proc.Start();
            Application.Current.Exit();
        }

        private void registerDeepLinking()
        {
            WindowsIdentity user = WindowsIdentity.GetCurrent();
            WindowsPrincipal principal = new WindowsPrincipal(user);
            bool isAdmin = principal.IsInRole(WindowsBuiltInRole.Administrator);

            if (isAdmin)
            {
                String directoryLocation = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                RegistryKey key = Registry.ClassesRoot.CreateSubKey("fullstacked", true);
                key.SetValue("", "url:protocol");
                key.SetValue("URL Protocol", "");

                RegistryKey shell = key.CreateSubKey(@"shell\open\command", true);
                shell.SetValue("", "\"" + directoryLocation + "\\FullStacked.exe\"  \"%1\"");

                shell.Close();
                key.Close();
            }
        }

        bool kiosk = false;
        string startId = "";
            
        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            string deeplink = "";
            string[] launchArgs = Environment.GetCommandLineArgs();
            for (int i = 0; i < launchArgs.Length; i++)
            {
                if (launchArgs[i].StartsWith("fullstacked://"))
                {
                    deeplink = launchArgs[i];
                }
                else if (launchArgs[i] == "--kiosk")
                {
                    this.kiosk = true;
                    if (launchArgs.Length > i + 1) { 
                        this.startId = launchArgs[i + 1];
                    }
                }
            }

            setDirectories();

            cb = new Lib.CallbackDelegate(onCallback);
            App.lib.setCallback(cb);

            WebView editor = new WebView(new Instance(this.startId, this.startId == ""));
            this.bringToFront(editor);
            if (deeplink != "" && this.startId == "")
            {
                editor.onMessage("deeplink", deeplink);
            }
        }
        private readonly Dictionary<string, (Window, WebView)> webviews = new();
        private Lib.CallbackDelegate cb;

        private void bringToFront(WebView webview)
        {
            String projectId = webview.instance.id;

            if (this.webviews.ContainsKey(projectId))
            {
                Window window = this.webviews[projectId].Item1;
                window.DispatcherQueue.TryEnqueue(() =>
                {
                    window.Activate();
                    webview.webview.Reload();
                });
                return;
            }

            Window newWindow = new();

            // TODO: set all of this by project
            newWindow.Title = "FullStacked";
            AppWindowTitleBar titleBar = newWindow.AppWindow.TitleBar;
            Color primarycolor = ColorHelper.FromArgb(1, 30, 41, 59);
            titleBar.BackgroundColor = primarycolor;
            titleBar.ButtonBackgroundColor = primarycolor;
            titleBar.ButtonHoverBackgroundColor = ColorHelper.FromArgb(1, 64, 73, 88);

            newWindow.AppWindow.SetIcon("Assets/Icon-16.ico");

            newWindow.Content = webview.webview;
            newWindow.Activate();
            this.webviews.Add(projectId, (newWindow, webview));
            newWindow.Closed += delegate (object sender, WindowEventArgs args)
            {
                this.webviews.Remove(projectId);
            };
            if (this.kiosk) {
                newWindow.AppWindow.SetPresenter(AppWindowPresenterKind.FullScreen);
            }
        }

        public void onCallback(string projectId, string messageType, string message)
        {
            if (projectId == "*")
            {
                foreach (var item in webviews.Values)
                {
                    item.Item2.onMessage(messageType, message);
                }
            }
            else if (projectId == "" && messageType == "open")
            {
                if (webviews.ContainsKey(message))
                {
                    this.bringToFront(webviews[message].Item2);
                }
                else
                {
                    this.bringToFront(new WebView(new Instance(message)));
                }
            }
            else if (webviews.ContainsKey(projectId))
            {
                WebView webview = webviews[projectId].Item2;
                webview.onMessage(messageType, message);
            }

           
        }


        public static void setDirectories()
        {
            string userDir = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string root = Path.Combine(userDir, "FullStacked");
            string config = Path.Combine(userDir, ".config", "fullstacked");
            string editor = Path.Combine(Windows.ApplicationModel.Package.Current.InstalledPath, "editor");

            byte[] rootBytes = Encoding.UTF8.GetBytes(root);
            byte[] configBytes = Encoding.UTF8.GetBytes(config);
            byte[] editorBytes = Encoding.UTF8.GetBytes(editor);

            fixed (void* rootPtr = rootBytes,
                configPtr = configBytes,
                editorPtr = editorBytes)
            {
                App.lib.setDirectories(
                    rootPtr,
                    configPtr,
                    editorPtr
                    );
            }
        }

        public static byte[] call(byte[] payload)
        {
            byte[] responsePtr;


            fixed (byte* p = payload, r = responsePtr)
            {
                int responseLength = App.lib.callLib(p, payload.Length, &r);

                byte[] response = new byte[responseLength];
                Marshal.Copy((IntPtr)r, response, 0, responseLength);

                App.lib.freePtrLib(r);

                return response;
            }
        }


        // END DLL Lib Bridge


        public static byte[] numberToByte(int num)
        {
            byte[] bytes = new byte[4];
            bytes[0] = (byte)((num & 0xff000000) >> 24);
            bytes[1] = (byte)((num & 0x00ff0000) >> 16);
            bytes[2] = (byte)((num & 0x0000ff00) >> 8);
            bytes[3] = (byte)((num & 0x000000ff) >> 0);
            return bytes;
        }

        public static byte[] combineBuffers(byte[][] buffers)
        {
            byte[] combined = new byte[buffers.Sum(x =>
            {
                if (x == null)
                {
                    return 0;
                }
                return x.Length;
            })];
            int offset = 0;
            foreach (byte[] buffer in buffers)
            {
                if (buffer == null)
                {
                    continue;
                }
                Array.Copy(buffer, 0, combined, offset, buffer.Length);
                offset += buffer.Length;
            }
            return combined;
        }

        public static void PrintByteArray(byte[] bytes)
        {
            var sb = new StringBuilder("new byte[] { ");
            foreach (var b in bytes)
            {
                sb.Append(b + ", ");
            }
            sb.Append("}");
            Trace.WriteLine(sb.ToString());
        }

        public static int bytesToNumber(byte[] bytes)
        {
            uint value = 0;
            foreach (byte b in bytes)
            {
                value = value << 8;
                value = value | b;
            }
            return (int)value;
        }

        public static int deserializeNumber(byte[] bytes)
        {
            bool negative = bytes[0] == 1;

            uint n = 0;
            int i = 1;
            while (i <= bytes.Length)
            {
                n += ((uint)bytes[i]) << ((i - 1) * 8);
                i += 1;
            }

            int value = (int)n;

            if (negative)
            {
                return 0 - value;
            }

            return value;
        }

        public static List<DataValue> deserializeArgs(byte[] bytes)
        {
            List<DataValue> args = new List<DataValue>();

            int cursor = 0;
            while (cursor < bytes.Length)
            {
                DataType type = (DataType)bytes[cursor];
                cursor++;
                int length = bytesToNumber(bytes[new Range(cursor, cursor + 4)]);
                cursor += 4;
                byte[] arg = bytes[new Range(cursor, cursor + length)];
                cursor += length;

                switch (type)
                {
                    case DataType.UNDEFINED:
                        args.Add(new DataValue());
                        break;
                    case DataType.BOOLEAN:
                        DataValue b = new()
                        {
                            boolean = arg[0] == 1 ? true : false
                        };
                        args.Add(b);
                        break;
                    case DataType.NUMBER:
                        DataValue n = new()
                        {
                            number = deserializeNumber(arg)
                        };
                        args.Add(n);
                        break;
                    case DataType.STRING:
                        DataValue s = new()
                        {
                            str = Encoding.UTF8.GetString(arg)
                        };
                        args.Add(s);
                        break;
                    case DataType.BUFFER:
                        DataValue buf = new()
                        {
                            buffer = arg
                        };
                        args.Add(buf);
                        break;
                    default:
                        break;
                }
            }

            return args;
        }
    }

    public class DataValue
    {
        public bool boolean;
        public string str;
        public int number;
        public byte[] buffer;
    }

}

enum DataType : int
{
    UNDEFINED = 0,
    BOOLEAN = 1,
    STRING = 2,
    NUMBER = 3,
    BUFFER = 4
}