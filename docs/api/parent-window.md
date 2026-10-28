# parentWindow

```ts
import parentWindow from "fullstacked/parentWindow";
```

Desktop hosts let a page size its own window. The runtime uses this to give every project a window that **reopens at the size and position it was left at**.

At startup, before the project's code runs, the bridge calls `parentWindow.setup()`:

1. If the host can't resize windows (it doesn't answer `GET /resize`), it does nothing.
2. It applies `process.env.WINDOW_SIZE` if set, otherwise the size saved in `/.git/window-size.txt`. `kiosk` is restored as `fullscreen`.
3. It saves the window's size to `/.git/window-size.txt` on every resize, debounced by 200 ms.

Sizes are strings: `"<width>:<height>:<x>:<y>"`, `"fullscreen"` (maximized) or `"kiosk"`.

| Export                    | Use                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disableAutoWindowSize()` | Stops saving the size from now on. The initial restore has already happened by the time your code runs. To control the size from the start, set `WINDOW_SIZE`. |
| `setup()`                 | Called by the runtime. You don't need to call it.                                                                                                              |

To start a project in kiosk mode:

```bash
fullstacked -e WINDOW_SIZE=kiosk .
```

Like [config](config.md), the size file lives in `.git/`, so it stays on the device.

The low-level hooks are `globalThis.fullstacked.window.resize(size)` and `getSize()`, which only exist on hosts that answer `GET /resize`.
