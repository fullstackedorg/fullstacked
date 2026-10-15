import { suite } from "node:test";
import nodeConstants from "node:constants";
import libConstants, * as libNamed from "../../../core/internal/bundle/lib/constants/index.ts";
import { check } from "../common.ts";
import assert from "node:assert";

// The table is Node's require("constants") of macOS, generated once
// (improvements/shim/plan.md 5.4): values are compared on darwin, names everywhere.
// defaultCipherList is left out: Node adds it once its TLS is loaded.
const nodeTable = Object.fromEntries(
    Object.entries(nodeConstants).filter(([k]) => k !== "defaultCipherList")
);

suite("shim constants", () => {
    check("constants", "same names as node:constants", () => {
        assert.deepStrictEqual(
            Object.keys(libConstants).sort(),
            Object.keys(nodeTable).sort()
        );
    });
    check("constants", "same values on darwin", () => {
        if (process.platform !== "darwin") return;
        assert.deepStrictEqual({ ...libConstants }, nodeTable);
    });
    check("constants", "named exports match the default", () => {
        for (const [key, value] of Object.entries(libConstants)) {
            assert.equal(
                (libNamed as Record<string, unknown>)[key],
                value,
                key
            );
        }
    });
});
