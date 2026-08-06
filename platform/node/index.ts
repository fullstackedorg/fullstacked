#!/usr/bin/env node
import fullstacked from "../../core/internal/bundle/lib/fullstacked/index.ts";
import { stop } from "./src/index.ts";

const code = await fullstacked.execute(process.argv);

const argsThatExits = [
    "-b",
    "--build",
    "-f",
    "--file",
    "-h",
    "--help",
    "-v",
    "--version"
];
const shouldExit = !!process.argv.find((arg) =>
    argsThatExits.find((exitArg) => arg.startsWith(exitArg))
);

if ((typeof code === "number" && code !== 0) || shouldExit) {
    stop();
}
