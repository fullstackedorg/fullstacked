// Transform mode against bundle mode: the same projects run both ways in a
// real webview (the Node host, headless Chromium) and must report the same
// page, and the same errors.
import test, { after, before, suite } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { createBrowser, type Browser } from "../browser.ts";
import bundle from "../../core/internal/bundle/lib/bundle/index.ts";

const root = ".cache/transform-parity";

// the lib's module names, as the core maps them (core/internal/bundle/bundle.go)
function libModuleNames() {
    const go = fs.readFileSync("core/internal/bundle/bundle.go", "utf-8");
    const block = go.slice(
        go.indexOf("var libModules"),
        go.indexOf("\n}\n", go.indexOf("var libModules"))
    );
    return (
        [...block.matchAll(/^\s*"([^"]+)":\s*"\/lib\/([^"]+)"/gm)]
            // modules that throw when used are imported, not called
            .map((m) => ({
                name: m[1],
                unavailable: m[2].startsWith("unavailable/")
            }))
    );
}

const packages: Record<string, string> = {
    "node_modules/cjs-fn/package.json": `{"name":"cjs-fn","main":"index.js"}`,
    "node_modules/cjs-fn/index.js": `module.exports = function cjsFn() { return "fn"; }; module.exports.extra = 1;`,
    "node_modules/cjs-obj/package.json": `{"name":"cjs-obj","main":"index.js"}`,
    "node_modules/cjs-obj/index.js": `exports.a = 1; exports.EventEmitter = require("events");`,
    "node_modules/cjs-esmodule/package.json": `{"name":"cjs-esmodule","main":"index.js"}`,
    "node_modules/cjs-esmodule/index.js": `Object.defineProperty(exports, "__esModule", { value: true }); exports.default = "transpiled default"; exports.named = "transpiled named";`,
    "node_modules/esm-only/package.json": `{"name":"esm-only","type":"module","exports":{".":{"import":"./index.js"},"./sub":{"import":"./sub.js"}}}`,
    "node_modules/esm-only/index.js": `export const named = "esm"; export default "esm default";`,
    "node_modules/esm-only/sub.js": `export const sub = "deep import";`,
    "node_modules/browser-pkg/package.json": `{"name":"browser-pkg","main":"node.js","browser":"browser.js"}`,
    "node_modules/browser-pkg/node.js": `module.exports = "node";`,
    "node_modules/browser-pkg/browser.js": `module.exports = "browser";`
};

function kitchenSink() {
    const libs = libModuleNames();
    const libImports = libs
        .map((m, i) => `import * as lib${i} from "${m.name}";`)
        .join("\n");
    const libReport = libs
        .map(
            (m, i) =>
                `    ${JSON.stringify(m.name)}: Object.keys(lib${i}).length > 0,`
        )
        .join("\n");
    return {
        ...packages,
        "package.json": `{"name":"kitchen-sink","private":true}`,
        "tsconfig.json": JSON.stringify({
            compilerOptions: {
                experimentalDecorators: true,
                baseUrl: ".",
                paths: { "@/*": ["src/*"] }
            }
        }),
        "src/aliased.ts": `export const aliased = "tsconfig paths";`,
        // not in the entry: bundle mode reads tsconfig.json for every file
        // but its entry (esbuild's stdin)
        "src/features.ts": `export { aliased } from "@/aliased";

function tag(value: string) {
    return (target: any) => {
        target.tag = value;
    };
}

@tag("decorated")
class Decorated {}

export const decorated = (Decorated as any).tag;
`,
        "style.css": `body { color: rgb(1, 2, 3); }`,
        "data.json": `{"key": "json value"}`,
        "logo.png": "not really a png",
        "index.ts": `import fn from "cjs-fn";
import * as objNs from "cjs-obj";
import { a, EventEmitter } from "cjs-obj";
import transpiled, { named as transpiledNamed } from "cjs-esmodule";
import esmDefault, { named } from "esm-only";
import { sub } from "esm-only/sub";
import browser from "browser-pkg";
import "./style.css";
import data from "./data.json";
import logo from "./logo.png";
import { aliased, decorated } from "./src/features";
import fs from "fs";
import path from "node:path";
import { Buffer } from "buffer";
import events from "events";
${libImports}

const lazy = await import("./src/lazy");

const report = {
    cjsDefault: fn(),
    cjsDefaultProperty: (fn as any).extra,
    cjsNamed: a,
    cjsNamespace: objNs.a,
    cjsRequiresLib: typeof EventEmitter,
    transpiled,
    transpiledNamed,
    esmDefault,
    named,
    sub,
    browser,
    cssApplied: getComputedStyle(document.body).color,
    data,
    logo: typeof logo === "string" && logo.endsWith(".png") && (await fetch(new URL(logo, location.href).pathname)).status,
    aliased,
    decorated,
    env: process.env.PARITY,
    dynamicImport: lazy.lazy,
    fs: fs.readFileSync("/data.json", "utf-8").includes("json value"),
    path: path.join("a", "b", "..", "c"),
    buffer: Buffer.from("parity").toString("base64"),
    events: typeof events,
    lib: {
${libReport}
    }
};

const pre = document.createElement("pre");
pre.id = "report";
pre.textContent = JSON.stringify(report, null, 2);
document.body.append(pre);
`,
        "src/lazy.ts": `export const lazy = "loaded on demand";`
    };
}

function writeFixture(name: string, files: Record<string, string>) {
    const dir = path.join(root, name);
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [file, contents] of Object.entries(files)) {
        const target = path.join(dir, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, contents);
    }
    return dir;
}

async function report(dir: string, mode: "bundle" | "transform") {
    const result =
        mode === "bundle"
            ? await bundle.bundle(dir)
            : await bundle.prepare(dir);
    assert.deepEqual(
        result.Errors ?? [],
        [],
        `${mode}: ${JSON.stringify(result.Errors)}`
    );
    const browser: Browser = await createBrowser(
        dir,
        { PARITY: "env value" },
        mode
    );
    try {
        const page = await browser.createPage();
        await page.page.waitForSelector("#report", { timeout: 30000 });
        return JSON.parse(await page.getTextContent("#report"));
    } finally {
        await browser.end();
    }
}

// the first error of a project that does not build, as both modes report it
async function firstError(dir: string, mode: "bundle" | "transform") {
    const result =
        mode === "bundle"
            ? await bundle.bundle(dir)
            : await bundle.prepare(dir);
    const error = result.Errors?.[0];
    assert.ok(error, `${mode} reports the error`);
    return {
        text: error.Text,
        file: path.basename(error.Location?.File ?? ""),
        line: error.Location?.Line,
        column: error.Location?.Column
    };
}

suite("transform mode - parity with bundle mode", () => {
    before(() => fs.mkdirSync(root, { recursive: true }));
    after(
        () =>
            process.env.KEEP_PARITY ||
            fs.rmSync(root, { recursive: true, force: true })
    );

    test("the same page", async () => {
        const dir = writeFixture("kitchen-sink", kitchenSink());
        const bundled = await report(dir, "bundle");
        fs.rmSync(path.join(dir, "out"), { recursive: true, force: true });
        const transformed = await report(dir, "transform");
        assert.deepEqual(transformed, bundled);
        // and what it reports is right
        assert.equal(bundled.cjsDefault, "fn");
        assert.equal(bundled.transpiled, "transpiled default");
        assert.equal(bundled.esmDefault, "esm default");
        assert.equal(bundled.browser, "browser");
        assert.equal(bundled.cssApplied, "rgb(1, 2, 3)");
        assert.equal(bundled.logo, 200);
        assert.equal(bundled.decorated, "decorated");
        assert.equal(bundled.env, "env value");
        assert.ok(Object.values(bundled.lib).every(Boolean));
    });

    test("the same syntax error", async () => {
        const dir = writeFixture("syntax-error", {
            "index.ts": `import { b } from "./b";\nconsole.log(b);\n`,
            "b.ts": `export const b = ;\n`
        });
        assert.deepEqual(
            await firstError(dir, "transform"),
            await firstError(dir, "bundle")
        );
    });

    test("the same missing import", async () => {
        const dir = writeFixture("missing-import", {
            "index.ts": `import { nope } from "./nope";\nconsole.log(nope);\n`
        });
        const transformed = await firstError(dir, "transform");
        const bundled = await firstError(dir, "bundle");
        // a bundle's entry starts with an import of the lib's prelude: its
        // lines are off by one in a bundle's errors, not in transform mode's
        assert.deepEqual(
            { ...transformed, line: undefined },
            { ...bundled, line: undefined }
        );
        assert.equal(transformed.line, 1);
    });
});
