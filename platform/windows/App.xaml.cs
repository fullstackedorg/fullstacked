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
        static Lib lib;
        static int callId = 0;


        bool kiosk = false;
        string startId = "";
        string deeplink = "";

        bool didLaunch = false;
        bool didConstruct = false;

        public App()
        {
            switch (RuntimeInformation.ProcessArchitecture)
            {
                case Architecture.X64:
                    App.lib = new LibX64();
                    break;
                case Architecture.Arm64:
                    App.lib = new LibARM64();
                    break;
                default:
                    throw new Exception("Unsupported arch");
            }

            this.InitializeComponent();
            this.registerDeepLinking();

            cb = new Lib.CallbackDelegate(onCallback);
            App.lib.setCallback(cb);

            setDirectories();

            this.didConstruct = true;
            this.launch();
        }

        private void launch() {
            if (!this.didLaunch || !this.didConstruct) return;

            WebView editor = new WebView(new Instance(this.startId, this.startId == ""));
            this.bringToFront(editor);
            if (this.deeplink != "" && this.startId == "")
            {
                editor.onMessage("deeplink", this.deeplink);
            }
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
            
        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            string[] launchArgs = Environment.GetCommandLineArgs();
            for (int i = 0; i < launchArgs.Length; i++)
            {
                if (launchArgs[i].StartsWith("fullstacked://"))
                {
                    this.deeplink = launchArgs[i];
                }
                else if (launchArgs[i] == "--kiosk")
                {
                    this.kiosk = true;
                    if (launchArgs.Length > i + 1) { 
                        this.startId = launchArgs[i + 1];
                    }
                }
            }

            this.didLaunch = true;
            this.launch();
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
            webview.window = newWindow;


            if (webview.instance.isEditor)
            {
                newWindow.Title = "FullStacked";
            }
            else {
                newWindow.Title = webview.instance.id;
            }

            AppWindowTitleBar titleBar = newWindow.AppWindow.TitleBar;
            Color primarycolor = ColorHelper.FromArgb(1, 30, 41, 59);
            titleBar.BackgroundColor = primarycolor;
            titleBar.ButtonBackgroundColor = primarycolor;
            titleBar.ButtonHoverBackgroundColor = ColorHelper.FromArgb(1, 64, 73, 88);

            newWindow.AppWindow.SetIcon("Assets/Window-Icon.ico");

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

        public void onCallback(string projectId, string messageType, IntPtr messageData, int messageLength)
        {
            byte[] byteArray = new byte[messageLength];
            Marshal.Copy(messageData, byteArray, 0, messageLength);
            string message = Encoding.UTF8.GetString(byteArray);

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
                if (messageType == "title") {
                    Window window = webviews[projectId].Item1;
                    window.Title = message;
                    return;
                }

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
            string tmp = Path.Combine(root, ".tmp");

            byte[] rootBytes = Encoding.UTF8.GetBytes(root);
            byte[] configBytes = Encoding.UTF8.GetBytes(config);
            byte[] editorBytes = Encoding.UTF8.GetBytes(editor);
            byte[] tmpBytes = Encoding.UTF8.GetBytes(tmp);

            fixed (void* rootPtr = rootBytes,
                configPtr = configBytes,
                editorPtr = editorBytes,
                tmpPtr = tmpBytes)
            {
                App.lib.setDirectories(
                    rootPtr,
                    configPtr,
                    editorPtr,
                    tmpPtr
                    );
            }
        }

        public static byte[] call(byte[] payload)
        {
            int id = callId++;
            fixed (byte* p = payload)
            {
                int responseLength = App.lib.callLib(id, p, payload.Length);

                byte[] response = new byte[responseLength];

                fixed (byte* r = response) {
                    App.lib.getReponseLib(id, r);
                }

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