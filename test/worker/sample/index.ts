import { Worker } from "worker_threads";

const worker = new Worker("./worker.ts.js");
worker.on("message", (event) => {
    const data = event.data;
    if (data && data.success) {
        document.body.classList.add("done");
        document.body.innerText = "SUCCESS";
    } else {
        document.body.classList.add("done");
        document.body.innerText = `FAILED: ${data?.error}`;
    }
});
worker.on("error", (err: any) => {
    document.body.classList.add("done");
    document.body.innerText = `ERROR: ${err.message || err}`;
});
