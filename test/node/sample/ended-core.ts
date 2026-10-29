// node test/node/sample/ended-core.ts <port of an echo server>
//
// Ends the core while a socket through it is open: the data the core still
// sends is dropped and calls into the ended core throw, the process does
// not abort.
import "../../../core/internal/bundle/lib/fullstacked/index.ts";
import net from "../../../core/internal/bundle/lib/net/index.ts";
import { stop } from "../../../platform/node/src/index.ts";

const socket = net.connect(Number(process.argv.at(-1)), "127.0.0.1");
await new Promise<void>((resolve) => socket.on("connect", resolve));
// echoed after the core ended
socket.write("ping");
stop();
stop();

try {
    globalThis.bridge.Sync(new Uint8Array(5).buffer);
    console.log("call: no error");
} catch (e) {
    console.log(`call: ${(e as Error).message}`);
}

await new Promise((resolve) => setTimeout(resolve, 1000));
console.log("still running");
