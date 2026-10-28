# Networking

All networking goes through the Go core, not the webview. Code in a page can open raw TCP and UDP sockets, resolve DNS, and `fetch` any origin with no CORS restriction, the same as server-side code in Node. Every network module also understands [tunnels](../api/tunnel.md): a registered tunnel's name can be used as a hostname.

There is **no server side**. A project can't listen on a port: there is no `net.createServer`, `http.createServer` or `dgram` multicast. See [Unavailable modules](unavailable.md#http-https-http2-tls).

Back to the [module table](index.md).

## net

`net.Socket`, `net.connect` and `net.createConnection` give a TCP client socket. It is a real `stream.Duplex` with Node's events (`connect`, `ready`, `data`, `end`, `close`, `error`), so drivers built on `node:net` work unchanged. The repository's tests run `pg` (through a tunnel) and `ssh2` (every algorithm OpenSSH accepts) in the webview.

```ts
import net from "node:net";

const socket = net.connect({ host: "example.com", port: 80 }, () => {
    socket.write("GET / HTTP/1.0\r\nHost: example.com\r\n\r\n");
});
socket.on("data", (chunk) => console.log(chunk.toString()));
```

- Arguments: `(port, host?)`, `({ port, host })`, with an optional connect listener. `host` defaults to `localhost`.
- The core dials **after** the call returns, in the stream's `Open`, so concurrent connects don't wait for each other. Writes made before `connect` are queued until the dial completes.
- Writes are queued in the core and batched. A write's callback waits while more than 1 MiB is queued in the core, until the queue falls to 256 KiB, so `write()`'s return value and `drain` follow the core's backpressure (see [flow control](../bridge.md#flow-control)).
- Reads arrive in chunks of up to 64 KiB.
- A refused dial, a DNS failure or a refused tunnel upgrade emits `error`, then `close`.
- `setNoDelay`, `setKeepAlive`, `setTimeout`, `ref` and `unref` are accepted.
- `isIP`, `isIPv4` and `isIPv6` are provided.

**Not provided**: `net.Server`/`createServer`, Unix domain sockets and named pipes (`path` option, which throws `socket to unix file unavailable`), `BlockList`, `SocketAddress`, and `localAddress`/`localPort` binding.

There is no `tls` module, so TLS over a raw socket isn't possible. Drivers that need TLS (`pg` with `ssl`, `mysql2` with `ssl`, `rediss://`) can't run. Use a plain connection over a [tunnel](../api/tunnel.md), which is itself `wss://`, or the service's HTTP API through `fetch`.

## dgram

`dgram.createSocket(type)` gives a UDP socket (`udp4` or `udp6`) with `bind(port?, address?, callback?)`, `send(msg, port, address, callback?)` (implicitly binds to `0.0.0.0:0` on first send), `close()`, `address()`, and the `message`, `listening`, `close` and `error` events.

**Not provided**: multicast and broadcast (`addMembership`, `setBroadcast`, `setMulticastTTL`, …), `connect`/`disconnect`, and buffer size options.

## dns

`dns.lookup(hostname, options?, callback)` and `dns/promises`: `lookup`, `resolve`, `resolve4`, `resolve6`, `resolveCname`, `resolveMx`, `resolveNs`, `resolveSrv` and `resolveTxt`. Lookups use Go's resolver on the host. The name of a registered tunnel resolves to the tunnel's hub host.

**Not provided**: the callback forms of `resolve*`, `reverse`, `Resolver`, `setServers` and `lookupService`.

## fetch and WebSocket

`globalThis.fetch` is replaced by the core's fetch, which runs in Go's `net/http`:

- **Any origin, no CORS.** Headers that browsers forbid (`Cookie`, `Origin`, `Host`, …) are sent as given.
- **Same-origin requests go to the project.** URLs starting with `/` and `fs://` use the webview's own fetch, which reads the project's [static files](../project-structure.md#static-files): `fetch("/data.json")`. Other relative URLs are resolved against `location`.
- `data:` URLs are decoded in JavaScript.
- HTTP/2 is attempted. Connections are pooled and kept alive. A request whose connection drops is retried up to 3 times. There is **no timeout**, so use an `AbortSignal`.
- `redirect: "manual"` or `"error"` stops at the first redirect.
- `signal` cancels the request in Go and rejects with an `AbortError`.
- The body streams: `response.body` is a `ReadableStream` that fills as the core reads.

The `Response` is a plain object, not the webview's `Response` class. It has `url`, `redirected`, `status`, `statusText`, `ok`, `headers` (a header sent several times keeps only its **last** value), `body`, `json()`, `text()`, `arrayBuffer()`, `blob()` and `bytes()`. `clone()` and `formData()` return `null`, `bodyUsed` is always `false`, and `type` is `"default"`.

The webview's original fetch is still available as `globalThis.fullstacked.fetch`, and the core fetch can be imported explicitly as `import fetch from "fullstacked/fetch"`.

`globalThis.WebSocket` is the core's WebSocket client (`fullstacked/websocket`) in pages and workers. It has the standard browser API: `url`, `readyState`, `protocol`, `binaryType` (`"blob"` or `"arraybuffer"`), `onopen`/`onmessage`/`onerror`/`onclose` and `addEventListener`, `send(string | ArrayBuffer | Blob | ArrayBufferView)`, and `close(code?, reason?)`. Like fetch, it reaches any origin from a page. A relative URL (`/socket`) is resolved against the page's origin as `ws:` or `wss:`. `bufferedAmount` is always 0 and `extensions` is always `""`. The webview's own WebSocket is kept as `globalThis.fullstacked.WebSocket`.

## Tunnels

A tunnel routes a project's connections through a FullStacked tunnel hub over a single multiplexed `wss://` connection, to the one target the hub assigns to that tunnel. Once a tunnel is registered, its **name works as a hostname** for `net.connect`, `fetch`, `WebSocket` and `dns` (the port is ignored), and git takes it as an option:

```ts
import tunnel from "fullstacked/tunnel";
import net from "node:net";

await tunnel.register({
    name: "db",
    host: "hub.example.com",
    authorization: "Bearer …"
});
const socket = net.connect({ host: "db", port: 5432 });
```

See [`tunnel`](../api/tunnel.md) for the full API and the wire protocol.
