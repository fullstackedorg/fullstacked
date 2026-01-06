// @ts-ignore
import t from "test";

const stream = await t.streamWrite(true);
stream.on("close", () => {
    document.body.classList.add("done");
})
stream.on("data", (chunk: Uint8Array) => {
    document.body.innerText += chunk.join("").toString();
})
await stream.write(new Uint8Array([1, 2, 3]));
stream.end();
