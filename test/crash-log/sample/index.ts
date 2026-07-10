// @ts-ignore
import t from "test";

document.body.innerText = "CRASHING";
document.body.classList.add("done");

const urlParams = new URLSearchParams(window.location.search);
const message = urlParams.get("message") || "PANIC_FROM_BROWSER";

// Wait for the bridge to be ready before calling panic
setTimeout(() => {
    t.panic(message);
}, 500);
