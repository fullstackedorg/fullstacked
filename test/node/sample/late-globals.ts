// fullstacked -f test/node/sample/late-globals.ts <port of a WebSocket server>
//
// A WebSocket made once the module settled (a reconnect) is still the
// core's, and window is still there.
const CoreWebSocket = globalThis.WebSocket;
const port = process.argv.filter((arg) => !arg.startsWith("-")).at(-1);

setTimeout(() => {
    console.log(`same WebSocket: ${globalThis.WebSocket === CoreWebSocket}`);
    console.log(`window: ${typeof window}`);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.onmessage = (e) => {
        console.log(`message: ${e.data}`);
        ws.close();
    };
    ws.onopen = () => ws.send("ping");
}, 100);
