import { after, before, suite, test } from "node:test";
import { createWebView } from "../../platform/node/src/webview";

let webview: Awaited<ReturnType<typeof createWebView>>;

suite("bundle - integration", () => {
    before(async () => {
        webview = await createWebView("test/bundle/sample");
    });

    test("fs", () => {});

    after(() => webview.close());
});
