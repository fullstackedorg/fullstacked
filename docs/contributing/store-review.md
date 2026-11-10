# Store review

What the app declares to the App Store, Google Play and the Microsoft Store, and why. FullStacked is a JavaScript runtime: the projects it runs are the user's code, and the app asks for a permission only when a project calls the web API that needs it. Keep this page in sync when a host starts using a new API or permission.

## Projects are interpreted code

A project is TypeScript or JavaScript. The core bundles it with esbuild (compiled into the core, no process is spawned) and the host loads the bundle in the platform's own webview: WKWebView on Apple platforms, Android System WebView, WebView2 on Windows, WebKitGTK or Qt WebEngine on Linux. The code runs in that webview's JavaScript engine, and everything it reaches beyond the web platform goes through the bridge to the Go core, which is compiled into the app (see [Architecture](../architecture.md)).

- No native code is downloaded or loaded at runtime. The core is a static library (Apple) or a shared library shipped in the package (Android, Windows, Linux). There is no `dlopen` of downloaded files, no Go plugins and no `child_process`: npm packages are installed as JavaScript, and a package's native addon (`.node`) is never loaded.
- The source of every project is on the device, in the projects directory, and the user can read and edit it.
- Apple: code runs in WebKit, which is what the App Store Review Guidelines expect from apps that run code they don't embed (sections 2.5.2 and 4.7). Google Play: the Device and Network Abuse policy excludes JavaScript run in a webview from its rule on downloaded executable code.
- Every project gets a [sandbox](../architecture.md#the-sandbox): its files are confined to its own directory. Network access isn't restricted.

## Apple

One target per platform in `platform/apple/FullStacked.xcodeproj`, `FullStacked-iOS` and `FullStacked-MacOS`, sharing `FullStacked/Info.plist`, `FullStacked/FullStacked.entitlements` and `FullStacked/PrivacyInfo.xcprivacy`. The core is linked statically (`core/bin/darwin.a`, `core/bin/ios-arm64.a`), and the app embeds no framework, so the app's privacy manifest covers the core.

### Privacy manifest

`PrivacyInfo.xcprivacy` is in the _Copy Bundle Resources_ phase of both targets.

| Key                           | Value                      | Why                                                                                                                                                                                                      |
| ----------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NSPrivacyTracking`           | `false`                    | The app doesn't track users.                                                                                                                                                                             |
| `NSPrivacyTrackingDomains`    | empty                      | No tracking domains.                                                                                                                                                                                     |
| `NSPrivacyCollectedDataTypes` | empty                      | The runtime collects nothing: no analytics, no crash reporting, no account. Network requests are made by the projects the user runs, to the servers those projects choose.                               |
| `NSPrivacyAccessedAPITypes`   | `FileTimestamp`: `C617.1`  | `stat`, `lstat`, `fstat` and `fstatat` in the core: `fs.stat`, git status, npm installs and esbuild read the timestamps and sizes of files in the projects directory, which is inside the app container. |
|                               | `SystemBootTime`: `35F9.1` | `mach_absolute_time` in the Go runtime: monotonic time for timers, `performance.now`, `process.hrtime` and timeouts. It measures time between events in the app and isn't sent anywhere.                 |

Not declared, because nothing in the app calls them: disk space (`statfs`, `getattrlist`, volume capacity keys), `UserDefaults`, active keyboards. The Swift code uses none of the required-reason APIs. To check the core after a change, build it and list the C functions it links:

```bash
make -C core/build darwin-arm64-static
```

```bash
nm -u core/bin/darwin-arm64.a | sort -u | grep -E '^_(stat|lstat|fstat|fstatat|getattrlist|getattrlistbulk|fgetattrlist|statfs|fstatfs|statvfs|fstatvfs|mach_absolute_time)$'
```

Today it prints the `stat` family and `mach_absolute_time`. Any other symbol from that list needs an entry with its reason in the manifest.

### Permissions

A project asks for a device feature through the web API, and WebKit shows its own prompt for the page before iOS or macOS show theirs. WebKit only exposes `navigator.mediaDevices` when the app has a camera or microphone purpose string, and it denies the request when the purpose string for it is missing. The strings are in `Info.plist`:

| Key                                   | Web API that triggers it                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `NSCameraUsageDescription`            | `getUserMedia({ video })`, and `<input type="file" accept="image/*" capture>` (the photo or video picker on iOS) |
| `NSMicrophoneUsageDescription`        | `getUserMedia({ audio })`, video capture from a file input                                                       |
| `NSPhotoLibraryAddUsageDescription`   | _Add to Photos_ in the context menu of an image (iOS)                                                            |
| `NSLocationWhenInUseUsageDescription` | `navigator.geolocation`                                                                                          |
| `NSSpeechRecognitionUsageDescription` | `webkitSpeechRecognition`                                                                                        |
| `NSLocalNetworkUsageDescription`      | TCP and UDP sockets (`net`, `dgram`), `fetch` and `WebSocket` to an address on the local network (iOS)           |

Not needed: the photo library read permission (the file input uses the system photo picker, which needs none), Bluetooth, USB, serial and NFC (WKWebView doesn't expose Web Bluetooth, WebUSB, Web Serial or Web NFC), and multicast (the core doesn't join multicast groups). WKWebView has no public API to show web notifications, so none is declared.

Other keys that review looks at: `ITSAppUsesNonExemptEncryption` is `NO`. The core has its own implementations of standard algorithms (TLS, SSH for git, `node:crypto`), so confirm the export compliance answers in App Store Connect when the crypto changes.

### Mac App Sandbox

`FullStacked.entitlements` (iOS ignores these keys):

| Entitlement                                         | Why                                                                                                                                                             |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `com.apple.security.app-sandbox`                    | Required for the Mac App Store.                                                                                                                                 |
| `com.apple.security.network.client`                 | Outgoing connections: the core's `net`, `fetch`, `WebSocket`, DNS, git and npm, and the webview.                                                                |
| `com.apple.security.network.server`                 | `dgram`: the core binds every UDP socket it opens (`net.ListenUDP`), even one that only sends and reads replies, and the sandbox refuses any `bind` without it. |
| `com.apple.security.files.user-selected.read-write` | The open panel of `<input type="file">`. Reading would be enough for it.                                                                                        |

Not needed: JIT (`com.apple.security.cs.allow-jit`), since JavaScript runs in WebKit's own processes and the Go core is compiled ahead of time; any exception for spawning processes, since the core never spawns one.

In the sandbox, the projects directory is the container's Documents: `~/Library/Containers/org.fullstacked/Data/Documents` (`NSSearchPathForDirectoriesInDomains(.documentDirectory)`). Downloads from a page go to its `downloads` folder. The core's temporary files (`os.MkdirTemp`) and its home directory (`~` in git config paths) are the container's too, so it never writes outside the container.

Without `com.apple.security.device.camera`, `com.apple.security.device.audio-input` and `com.apple.security.personal-information.location`, the sandbox denies the camera, the microphone and the location to WKWebView on macOS: `getUserMedia` and `navigator.geolocation` fail with a permission error. Add them to give projects these features on the Mac, and say so in the review notes.

## Android

`platform/android/studio/app/src/main/AndroidManifest.xml`:

| Permission             | Why                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `INTERNET`             | The core's sockets, DNS, `fetch`, `WebSocket`, git and npm, and the webview.                                      |
| `ACCESS_NETWORK_STATE` | The webview's `navigator.onLine` and `online`/`offline` events.                                                   |
| `REORDER_TASKS`        | `ActivityManager.moveTaskToFront`, which brings the project's window back after a sign-in redirect or a deeplink. |

The app has no dangerous permission. It doesn't read external storage (projects are in `filesDir/projects`), and it has no `QUERY_ALL_PACKAGES`, SMS, call log, contacts, camera, microphone or location permission.

- **Webview permissions.** `WebChromeClient` doesn't override `onPermissionRequest` or `onGeolocationPermissionsShowPrompt`, so the webview denies camera, microphone and location requests without a prompt. Giving projects these features means overriding both, asking for the runtime permission (`CAMERA`, `RECORD_AUDIO`, `ACCESS_FINE_LOCATION`) when the page asks, and declaring the permission here.
- **File input.** `onShowFileChooser` launches the system picker (`ACTION_GET_CONTENT`), which needs no permission.
- **Cleartext traffic.** `usesCleartextTraffic` is `true`: the page is served on `http://localhost` (answered by `shouldInterceptRequest`, it never reaches the network), and projects load `http://` resources from devices and servers on the local network. Review tools flag it, so justify it as a developer tool.
- **Exported activities.** `MainActivity` (launcher, `fullstacked-ctx://` to open a project's window), `DeepLinkActivity` (`fullstacked://`) and `AuthCallbackActivity` (`fullstacked-auth://`) are exported for their `VIEW` intent filters, and only take a URL.
- **Backup.** `allowBackup` is on, with the default rules: the projects directory is backed up.

## Windows

`platform/windows/Package.appxmanifest`:

| Capability       | Why                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `runFullTrust`   | Required: the app is a packaged WinUI 3 (Windows App SDK) desktop app, whose entry point is `Windows.FullTrustApplication`.         |
| `internetClient` | The core's networking and WebView2. A full-trust process isn't limited by capabilities, so it's informative, for the Store listing. |

The projects directory is `%LOCALAPPDATA%\fullstacked`. In an MSIX package, Windows redirects it to the package's own data folder, which is removed with the app.

WebView2 shows its own prompt for the camera, the microphone and the location (`WebView.cs` doesn't handle `PermissionRequested`). For a packaged app, Windows may also expect the matching device capabilities (`webcam`, `microphone`, `location`), which aren't declared: test on a device before adding them.
