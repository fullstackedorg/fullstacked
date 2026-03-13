import test, { afterEach, before, beforeEach, suite } from "node:test";
import child_process from "node:child_process";
import fs from "node:fs";
import packages from "../../core/internal/bundle/lib/packages/index.ts";
import assert from "node:assert";

suite("packages - e2e", () => {
    const testDirectory = "test/packages/test";
    const testDirectoryGo = `${testDirectory}/go/test`;
    const testDirectoryNode = `${testDirectory}/node/test`;

    const clean = () => {
        if (fs.existsSync(testDirectory)) {
            fs.rmSync(testDirectory, { recursive: true });
        }
    };

    before(clean);

    beforeEach(() => {
        fs.mkdirSync(testDirectoryGo, { recursive: true });
        fs.mkdirSync(testDirectoryNode, { recursive: true });
        fs.writeFileSync(
            `${testDirectoryNode}/package.json`,
            `{"scripts":{"test":"echo test"}}`
        );
        fs.writeFileSync(
            `${testDirectoryGo}/package.json`,
            `{"scripts":{"test":"echo test"}}`
        );
    });
    afterEach(clean);

    test("go", () => {
        child_process.execSync("go test -cover", {
            cwd: "core/internal/packages",
            stdio: ["ignore", "ignore", "inherit"]
        });
    });

    test("install", async () => {
        await new Promise<void>(async (res) => {
            const ee = await packages.install(testDirectoryGo, false, "react");
            ee.duplex.on("close", res);
        });
        child_process.execSync("npm install react", { cwd: testDirectoryNode });
        const packageJSON = fs.readFileSync(`${testDirectoryGo}/package.json`, {
            encoding: "utf-8"
        });
        const packageJSONNode = fs.readFileSync(
            `${testDirectoryNode}/package.json`,
            { encoding: "utf-8" }
        );
        assert.deepStrictEqual(
            JSON.parse(packageJSON),
            JSON.parse(packageJSONNode)
        );
        const packageLock = fs.readFileSync(
            `${testDirectoryGo}/package-lock.json`,
            { encoding: "utf-8" }
        );
        const packageLockNode = fs.readFileSync(
            `${testDirectoryNode}/package-lock.json`,
            { encoding: "utf-8" }
        );
        assert.deepStrictEqual(
            JSON.parse(packageLock),
            JSON.parse(packageLockNode)
        );
    });

    test("install - multiple packages", async () => {
        await new Promise<void>(async (res) => {
            const ee = await packages.install(
                testDirectoryGo,
                false,
                "react",
                "react-dom",
                "@types/react",
                "@types/react-dom"
            );
            ee.duplex.on("close", res);
        });
        child_process.execSync(
            "npm install react react-dom @types/react @types/react-dom",
            { cwd: testDirectoryNode }
        );
        const packageJSON = fs.readFileSync(`${testDirectoryGo}/package.json`, {
            encoding: "utf-8"
        });
        const packageJSONNode = fs.readFileSync(
            `${testDirectoryNode}/package.json`,
            { encoding: "utf-8" }
        );
        assert.deepStrictEqual(
            JSON.parse(packageJSON),
            JSON.parse(packageJSONNode)
        );
        const packageLock = fs.readFileSync(
            `${testDirectoryGo}/package-lock.json`,
            { encoding: "utf-8" }
        );
        const packageLockNode = fs.readFileSync(
            `${testDirectoryNode}/package-lock.json`,
            { encoding: "utf-8" }
        );
        assert.deepStrictEqual(
            JSON.parse(packageLock),
            JSON.parse(packageLockNode)
        );
    });

    test("uninstall", async () => {
        await new Promise<void>(async (res) => {
            const ee = await packages.install(
                testDirectoryGo,
                false,
                "react",
                "react-dom",
                "@types/react",
                "@types/react-dom"
            );
            ee.duplex.on("close", res);
        });

        await new Promise<void>(async (res) => {
            const ee = await packages.uninstall(
                testDirectoryGo,
                "@types/react"
            );
            ee.duplex.on("close", res);
        });

        child_process.execSync(
            "npm install react react-dom @types/react @types/react-dom",
            { cwd: testDirectoryNode }
        );
        child_process.execSync("npm uninstall @types/react", {
            cwd: testDirectoryNode
        });

        const packageJSON = fs.readFileSync(`${testDirectoryGo}/package.json`, {
            encoding: "utf-8"
        });
        const packageJSONNode = fs.readFileSync(
            `${testDirectoryNode}/package.json`,
            { encoding: "utf-8" }
        );
        assert.deepStrictEqual(
            JSON.parse(packageJSON),
            JSON.parse(packageJSONNode)
        );
        const packageLock = fs.readFileSync(
            `${testDirectoryGo}/package-lock.json`,
            { encoding: "utf-8" }
        );
        const packageLockNode = fs.readFileSync(
            `${testDirectoryNode}/package-lock.json`,
            { encoding: "utf-8" }
        );
        assert.deepStrictEqual(
            JSON.parse(packageLock),
            JSON.parse(packageLockNode)
        );
    });

    test("install - git repository", async () => {
        await new Promise<void>(async (res) => {
            const ee = await packages.install(
                testDirectoryGo,
                false,
                "https://github.com/fullstackedorg/builder-tailwindcss.git"
            );
            ee.duplex.on("close", res);
        });

        child_process.execSync(
            "npm install https://github.com/fullstackedorg/builder-tailwindcss.git",
            {
                cwd: testDirectoryNode,
                stdio: "ignore"
            }
        );

        assert.deepEqual(
            JSON.parse(
                fs.readFileSync(`${testDirectoryGo}/package.json`, {
                    encoding: "utf-8"
                })
            ),
            JSON.parse(
                fs.readFileSync(`${testDirectoryNode}/package.json`, {
                    encoding: "utf-8"
                })
            )
        );

        assert.deepEqual(
            fs.readdirSync(`${testDirectoryGo}/node_modules`),
            fs.readdirSync(`${testDirectoryNode}/node_modules`)
        );

        assert.deepEqual(
            fs.readdirSync(
                `${testDirectoryGo}/node_modules/@fullstacked/builder-tailwindcss`
            ),
            fs.readdirSync(
                `${testDirectoryNode}/node_modules/@fullstacked/builder-tailwindcss`
            )
        );

        fs.rmSync(`${testDirectoryGo}/node_modules`, { recursive: true });
        fs.rmSync(`${testDirectoryNode}/node_modules`, { recursive: true });

        fs.cpSync(
            `${testDirectoryNode}/package.json`,
            `${testDirectoryGo}/package.json`
        );
        fs.cpSync(
            `${testDirectoryNode}/package-lock.json`,
            `${testDirectoryGo}/package-lock.json`
        );

        await new Promise<void>(async (res) => {
            const ee = await packages.install(testDirectoryGo, false);
            ee.duplex.on("close", res);
        });

        child_process.execSync("npm install", {
            cwd: testDirectoryNode,
            stdio: "ignore"
        });

        assert.deepEqual(
            JSON.parse(
                fs.readFileSync(`${testDirectoryGo}/package.json`, {
                    encoding: "utf-8"
                })
            ),
            JSON.parse(
                fs.readFileSync(`${testDirectoryNode}/package.json`, {
                    encoding: "utf-8"
                })
            )
        );

        assert.deepEqual(
            fs.readdirSync(`${testDirectoryGo}/node_modules`),
            fs.readdirSync(`${testDirectoryNode}/node_modules`)
        );

        assert.deepEqual(
            fs.readdirSync(
                `${testDirectoryGo}/node_modules/@fullstacked/builder-tailwindcss`
            ),
            fs.readdirSync(
                `${testDirectoryNode}/node_modules/@fullstacked/builder-tailwindcss`
            )
        );
    });

    test("install - ssh2", async () => {
        await new Promise<void>(async (res) => {
            const ee = await packages.install(testDirectoryGo, false, "ssh2");
            ee.duplex.on("close", res);
        });

        child_process.execSync("npm install ssh2", {
            cwd: testDirectoryNode,
            stdio: "ignore"
        });

        assert.deepEqual(
            JSON.parse(
                fs.readFileSync(`${testDirectoryGo}/package.json`, {
                    encoding: "utf-8"
                })
            ),
            JSON.parse(
                fs.readFileSync(`${testDirectoryNode}/package.json`, {
                    encoding: "utf-8"
                })
            )
        );

        assert.deepEqual(
            fs.readdirSync(`${testDirectoryGo}/node_modules`),
            fs.readdirSync(`${testDirectoryNode}/node_modules`)
        );

        assert.deepEqual(
            fs.readdirSync(`${testDirectoryGo}/node_modules/ssh2`),
            fs.readdirSync(`${testDirectoryNode}/node_modules/ssh2`)
        );
    });
});
