// @ts-ignore
import "fullstacked";
// @ts-ignore
import t from "test";
import type test from "../../../core/internal/bundle/lib/test/index.ts";

const eventEmitter: Awaited<ReturnType<typeof test.eventEmitter>> =
    await t.eventEmitter(
        0,
        undefined,
        false,
        "string",
        2,
        new Uint8Array([1, 2, 3]),
        { foo: "testing" }
    );
const pre = document.createElement("pre");
document.body.append(pre);
eventEmitter.on(
    "event",
    (data) =>
        (pre.innerHTML +=
            (typeof data === "object" && !data?.buffer
                ? JSON.stringify(data)
                : data) + " ")
);
eventEmitter.duplex.on("close", () => document.body.classList.add("done"));
