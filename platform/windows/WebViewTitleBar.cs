using Microsoft.UI.Dispatching;
using Microsoft.UI.Windowing;
using Microsoft.Web.WebView2.Core;
using System;
using System.Globalization;
using System.Text.Json;
using Windows.UI;

namespace FullStacked
{
    // The title bar shows the page's title and takes its background, like the
    // window's title bar on macOS (title and underPageBackgroundColor, read every
    // second by the WebViewStore). The page's background is its html's, else its
    // body's; a page without one keeps the system's title bar.
    internal partial class WebView
    {
        private const string BackgroundScript =
            "(() => {" +
            "  const bg = (el) => {" +
            "    if (!el) return '';" +
            "    const c = getComputedStyle(el).backgroundColor;" +
            "    return c && c !== 'transparent' && !/^rgba\\(.*,\\s*0\\)$/.test(c) ? c : '';" +
            "  };" +
            "  return bg(document.documentElement) || bg(document.body);" +
            "})()";

        private DispatcherQueueTimer titleBarTimer;
        private Color? titleBarColor;

        private void StartTitleBarSync(CoreWebView2 coreWebView2)
        {
            // the window's title is the page's, "FullStacked" when it has none
            // (as on macOS)
            void syncTitle()
            {
                if (this.isClosed) return;
                string title = coreWebView2.DocumentTitle?.Trim();
                this.Title = string.IsNullOrEmpty(title) ? "FullStacked" : title;
            }
            coreWebView2.DocumentTitleChanged += (_, _) => syncTitle();
            syncTitle();

            if (!AppWindowTitleBar.IsCustomizationSupported()) return;

            coreWebView2.NavigationCompleted += (_, _) => this.SyncTitleBar();

            this.titleBarTimer = this.DispatcherQueue.CreateTimer();
            this.titleBarTimer.Interval = TimeSpan.FromSeconds(1);
            this.titleBarTimer.Tick += (_, _) => this.SyncTitleBar();
            this.titleBarTimer.Start();

            this.Closed += (_, _) => this.titleBarTimer?.Stop();
        }

        private async void SyncTitleBar()
        {
            var coreWebView2 = this.coreWebView2;
            if (this.isClosed || coreWebView2 == null) return;

            string css;
            try
            {
                // the result is JSON: a quoted string
                css = JsonSerializer.Deserialize<string>(await coreWebView2.ExecuteScriptAsync(BackgroundScript));
            }
            catch
            {
                return;
            }
            if (this.isClosed || !TryParseCssColor(css, out Color color)) return;
            if (this.titleBarColor.Equals(color)) return;
            this.titleBarColor = color;

            this.ApplyTitleBarColor(color);
        }

        private void ApplyTitleBarColor(Color background)
        {
            var bar = this.AppWindow.TitleBar;

            // black or white text, whichever reads on the background
            bool light = (0.2126 * background.R + 0.7152 * background.G + 0.0722 * background.B) / 255 > 0.6;
            Color text = light ? Color.FromArgb(255, 0, 0, 0) : Color.FromArgb(255, 255, 255, 255);
            Color dimmed = light ? Color.FromArgb(255, 110, 110, 110) : Color.FromArgb(255, 160, 160, 160);
            Color hover = Mix(background, text, 0.12);
            Color pressed = Mix(background, text, 0.22);

            bar.BackgroundColor = background;
            bar.InactiveBackgroundColor = background;
            bar.ForegroundColor = text;
            bar.InactiveForegroundColor = dimmed;

            bar.ButtonBackgroundColor = background;
            bar.ButtonInactiveBackgroundColor = background;
            bar.ButtonForegroundColor = text;
            bar.ButtonInactiveForegroundColor = dimmed;
            bar.ButtonHoverBackgroundColor = hover;
            bar.ButtonHoverForegroundColor = text;
            bar.ButtonPressedBackgroundColor = pressed;
            bar.ButtonPressedForegroundColor = text;
        }

        private static Color Mix(Color a, Color b, double t) => Color.FromArgb(
            255,
            (byte)Math.Round(a.R + (b.R - a.R) * t),
            (byte)Math.Round(a.G + (b.G - a.G) * t),
            (byte)Math.Round(a.B + (b.B - a.B) * t));

        // "rgb(r, g, b)" or "rgba(r, g, b, a)", as getComputedStyle gives them; a
        // translucent color is laid on white, like the page draws it
        private static bool TryParseCssColor(string css, out Color color)
        {
            color = default;
            if (string.IsNullOrEmpty(css)) return false;
            int open = css.IndexOf('('), close = css.LastIndexOf(')');
            if (open < 0 || close <= open) return false;

            string[] parts = css.Substring(open + 1, close - open - 1)
                .Replace("/", ",")
                .Split(new[] { ',', ' ' }, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 3) return false;

            double[] v = new double[4] { 0, 0, 0, 1 };
            for (int i = 0; i < Math.Min(parts.Length, 4); i++)
            {
                string p = parts[i].Trim();
                bool percent = p.EndsWith("%");
                if (!double.TryParse(p.TrimEnd('%'), NumberStyles.Float, CultureInfo.InvariantCulture, out double n)) return false;
                v[i] = percent ? (i < 3 ? n * 2.55 : n / 100) : n;
            }

            double alpha = Math.Clamp(v[3], 0, 1);
            byte channel(double c) => (byte)Math.Round(Math.Clamp(c, 0, 255) * alpha + 255 * (1 - alpha));
            color = Color.FromArgb(255, channel(v[0]), channel(v[1]), channel(v[2]));
            return true;
        }
    }
}
