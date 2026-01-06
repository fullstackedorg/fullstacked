// @ts-ignore
import t from "test";

const stream = await t.streaming(new Uint8Array([1, 2, 3]), 0, true);
for await (const chunk of stream) {
    document.body.innerText += chunk.join("").toString();
}
document.body.classList.add("done");
