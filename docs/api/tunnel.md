# tunnel

```ts
import tunnel from "fullstacked/tunnel";
```

A tunnel routes a project's outbound connections through a **tunnel hub**: a server reachable over WebSocket that dials the tunnel's **target** for each connection. It reaches a service that a device can't reach directly (a database on a private network, a service on `localhost` of another machine) without a VPN, and all of a tunnel's connections share one `wss://` connection.

Each tunnel leads to **one target**. Which one is the hub's configuration, for example keyed by the tunnel's `path` and `authorization`. The runtime never sends a destination.

## register

```ts
register(tunnel: {
    host: string;           // the hub
    name?: string;          // default: 8 random letters
    port?: number;          // default: 443, or 80 when unsecure
    path?: string;          // WebSocket path on the hub
    unsecure?: boolean;     // ws:// instead of wss://
    authorization?: string; // sent as the Authorization header of the hub handshake
}): Promise<string>         // the tunnel's name
```

Once it is registered, **the tunnel's name is a hostname**. Every connection to that name goes through the hub to the tunnel's target. **The port you connect to is ignored**:

```ts
const name = await tunnel.register({
    name: "office",
    host: "hub.example.com",
    authorization: `Bearer ${token}`
});

net.connect({ host: "office", port: 5432 }); // net (pg, redis, ssh2, …): the target
await fetch("http://office/api/health"); // fetch: HTTP over a connection to the target
new WebSocket("ws://office/events"); // WebSocket, the same way
await git.clone("http://git.internal/team/repo.git", "/repo", {
    tunnel: "office"
}); // git: its connections go to the target
```

`dns.lookup("office")` resolves to the hub's host.

Re-registering a name with the same parameters only warms the connection pool. Different parameters replace the hub sessions: existing connections finish on the old sessions, and new ones use the new parameters.

The registry belongs to the core process, not to a context, so a tunnel registered by one project is visible to the others in the same app.

## How it works

The core keeps a pool of WebSocket **sessions** to the hub and multiplexes **streams** over them. Each `net.connect`, fetch connection or WebSocket is one stream. The runtime picks stream ids and never reuses one within a session.

- A pool has up to 8 sessions and 32 streams per session, opened as needed. An idle session closes after 30 s, and the last one after 2 min.
- A failed hub dial is retried after 50 ms and 200 ms. A hub that refuses the upgrade (401, 403) fails the connection as a socket error.
- Each stream has a 256 KiB flow-control window, and data messages carry up to 32 KiB.

Frames on the WebSocket:

```text
[type u8][stream id u32 BE][payload]
```

| Type | Name   | Payload                                                    |
| ---- | ------ | ---------------------------------------------------------- |
| 1    | OPEN   | (empty) The hub dials the tunnel's target                  |
| 2    | OPENED | The target is dialed                                       |
| 3    | DATA   | Up to 32 KiB of bytes                                      |
| 4    | WINDOW | u32 BE: bytes the peer may send in addition                |
| 5    | FIN    | No more data from this side                                |
| 6    | RESET  | Abort; the payload is the reason (`target_unreachable`, …) |

The hub's side of the protocol is specified in the [`fullstackedorg/tunnels`](https://github.com/fullstackedorg/tunnels) repository.
