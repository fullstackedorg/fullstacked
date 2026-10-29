import test, { suite } from "node:test";
import assert from "node:assert";
import nodeUrl from "node:url";
import os from "node:os";
import shimUrl from "../../core/internal/bundle/lib/url/index.ts";

const isWindows = os.platform() === "win32";

suite("url - e2e", () => {
    test("domainToASCII", () => {
        const domains = ["example.com", "sub.domain.org"];
        for (const d of domains) {
            assert.equal(shimUrl.domainToASCII(d), nodeUrl.domainToASCII(d));
        }
    });

    test("domainToUnicode", () => {
        const domains = ["example.com"];
        for (const d of domains) {
            assert.equal(
                shimUrl.domainToUnicode(d),
                nodeUrl.domainToUnicode(d)
            );
        }
    });

    test("fileURLToPath", () => {
        const urls = isWindows
            ? ["file:///C:/path/to/file", "file:///C:/path/with%20space"]
            : ["file:///path/to/file", "file:///path/with%20space"];
        // For POSIX paths, our shim mimics node precisely
        for (const u of urls) {
            assert.equal(shimUrl.fileURLToPath(u), nodeUrl.fileURLToPath(u));
        }
    });

    test("fileURLToPathBuffer", () => {
        const urlObj = isWindows
            ? new URL("file:///C:/path/to/file")
            : new URL("file:///path/to/file");
        // Using assert.deepEqual for Buffer comparison
        // Note: url.fileURLToPathBuffer doesn't exist in all node versions. We test if it is exported.
        if (typeof nodeUrl.fileURLToPathBuffer === "function") {
            assert.deepEqual(
                shimUrl.fileURLToPathBuffer(urlObj),
                nodeUrl.fileURLToPathBuffer(urlObj)
            );
        }
    });

    test("format", () => {
        const myUrl = new URL(
            "http://user:pass@example.com:8080/path?query=1#hash"
        );

        const testOptions = [
            undefined,
            { auth: false },
            { fragment: false },
            { search: false },
            { auth: false, fragment: false, search: false }
        ];

        for (const opt of testOptions) {
            assert.equal(
                shimUrl.format(myUrl, opt),
                nodeUrl.format(myUrl, opt)
            );
        }
    });

    test("pathToFileURL", () => {
        const paths = ["/path/to/file", "/path/with space"];
        // For POSIX paths
        for (const p of paths) {
            assert.equal(
                shimUrl.pathToFileURL(p).href,
                nodeUrl.pathToFileURL(p).href
            );
        }
    });

    test("urlToHttpOptions", () => {
        const urlStr = "http://user:pass@example.com:8080/path?query=1#hash";
        const urlObj = new URL(urlStr);
        assert.deepEqual(
            shimUrl.urlToHttpOptions(urlObj),
            nodeUrl.urlToHttpOptions(urlObj)
        );

        const ipv6Str = new URL("http://[::1]:8080/");
        assert.deepEqual(
            shimUrl.urlToHttpOptions(ipv6Str),
            nodeUrl.urlToHttpOptions(ipv6Str)
        );
    });
});
