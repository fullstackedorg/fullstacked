# auth

```ts
import auth from "fullstacked/auth";
```

A small helper for popup sign-in flows: it opens a page in a popup and resolves with the message that page posts back.

```ts
authenticate(url: string, opts?: { windowFeatures?: string }): Promise<any>
```

1. `auth=1` is added to `url`'s query, so the sign-in page knows it runs in a FullStacked popup.
2. `url` is opened with `window.open`, centered at 500×600 unless `windowFeatures` is given.
3. The promise resolves with the `data` of the first `message` event the window receives. If that `data` is an `Error`, it rejects instead.

The sign-in page ends the flow with `window.opener.postMessage(result, "*")`. Pick a target origin that fits your flow.

```ts
const session = await auth.authenticate("https://accounts.example.com/sign-in");
```

## In the native apps

Identity providers refuse sign-in inside embedded webviews, so the apps open the page in the system browser instead of a popup: `ASWebAuthenticationSession` on iOS and macOS, Custom Tabs on Android, the default browser on Windows. They add `native=1` and `callback_scheme=fullstacked-auth` to the query. The sign-in page then ends the flow by redirecting to `fullstacked-auth://auth?<result as query parameters>`, and the app delivers those parameters, as an object, as the `message` the promise resolves with. There is no `window.opener` in this mode.

Inside the runtime, closing the popup without posting doesn't reject the promise. The closed-window check only runs outside FullStacked. Give your UI a way to cancel.

The module only uses `window`, so it is for pages, not workers or `--file` scripts.
