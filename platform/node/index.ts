#!/usr/bin/env node
import fullstacked, {
    splitFileArgs
} from "../../core/internal/bundle/lib/fullstacked/index.ts";
import { keepRunning, stop } from "./src/index.ts";

// only the CLI's own options count: the arguments after `-f <file>` are the
// script's (process.argv[0..1] are node and this file)
const { cliArgs } = splitFileArgs(process.argv.slice(2));
const matches = (args: string[]) =>
    !!cliArgs.find((arg) => args.find((flag) => arg.startsWith(flag)));
const exits = matches(["-b", "--build", "-h", "--help", "-v", "--version"]);
const runsFile = matches(["-f", "--file"]);

// -n, --no-open on Node serves without opening the browser (see
// src/webview.ts): the page is still served
const noOpenArgs = ["-n", "--no-open"];
const argv = runsFile
    ? process.argv
    : process.argv.filter((arg) => !noOpenArgs.includes(arg));

const code = await fullstacked.execute(argv, { keepGlobals: runsFile });

if (typeof code === "number" && code !== 0) {
    process.exitCode = code;
    stop();
} else if (exits) {
    stop();
} else if (runsFile) {
    // the script runs until nothing does (timers, open sockets and tunnel
    // sessions...), not only until its module settled
    process.once("beforeExit", stop);
} else {
    keepRunning();
}
