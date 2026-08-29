import "../bridge/index.ts";
import { bundle, bundleFile } from "../bundle/index.ts";
import run from "../run/index.ts";
import plugin from "../plugin/index.ts";
import packages from "../packages/index.ts";
import path from "../path/index.ts";
import fs from "../fs/index.ts";
import version from "../process/version.json" with { type: "json" };
import os from "../os/index.ts";
import { getActiveInterfaces, waitForInterfaces } from "../readline/interface.ts";

export interface ExecuteOptions {
    stdio?: any[];
}

function createConsoleStream(consoleFn: (...args: any[]) => void) {
    let buffer = "";
    return {
        write(chunk: string | Uint8Array) {
            const str =
                typeof chunk === "string"
                    ? chunk
                    : new TextDecoder().decode(chunk);
            buffer += str;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
                consoleFn(line);
            }
        },
        writeln(msg: string) {
            if (buffer) {
                consoleFn(buffer + msg);
                buffer = "";
            } else {
                consoleFn(msg);
            }
        }
    };
}

function getWriter(stream: any) {
    if (!stream) return (msg: string) => console.log(msg);
    if (typeof stream.writeln === "function") {
        return (msg: string) => stream.writeln(msg);
    }
    if (typeof stream.write === "function") {
        return (msg: string) =>
            stream.write(
                typeof msg === "string" && !msg.endsWith("\n")
                    ? msg + "\n"
                    : msg
            );
    }
    return (msg: string) => console.log(msg);
}

function formatMessage(msg: any, isWarning = false): string {
    const color = isWarning ? "\x1b[33m" : "\x1b[31m";
    const label = isWarning ? "WARNING" : "ERROR";

    if (typeof msg === "string") {
        return `${color}${msg}\x1b[0m\n`;
    }

    const text = msg.Text || msg.text;
    if (text) {
        let out = `\x1b[1m${color}[${label}]\x1b[0m \x1b[1m${text}\x1b[0m`;

        const loc = msg.Location || msg.location;
        if (loc) {
            const file = loc.File || loc.file;
            const line = loc.Line || loc.line;
            const col = loc.Column || loc.column;
            if (file) {
                out += `\n  \x1b[90mat ${file}${line !== undefined ? `:${line}` : ""}${col !== undefined ? `:${col}` : ""}\x1b[0m`;
            }
            const lineText = loc.LineText || loc.lineText;
            if (lineText) {
                out += `\n    ${lineText}`;
                if (typeof col === "number" && col > 0) {
                    out += `\n    ${" ".repeat(col - 1)}\x1b[32m^\x1b[0m`;
                }
            }
        }

        const notes = msg.Notes || msg.notes;
        if (Array.isArray(notes)) {
            notes.forEach((note: any) => {
                const noteText = note.Text || note.text;
                if (noteText) {
                    out += `\n  \x1b[36mNote:\x1b[0m ${noteText}`;
                }
            });
        }
        return out + "\n";
    }
    return JSON.stringify(msg, null, 2) + "\n";
}

function findArgValues(aliases: string[], args: string[]): string[] {
    const values: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (aliases.includes(arg)) {
            const next = args[i + 1];
            if (next !== undefined && !next.startsWith("-")) {
                values.push(next);
                i++;
            } else {
                values.push("");
            }
        } else {
            for (const alias of aliases) {
                if (arg.startsWith(alias + "=")) {
                    values.push(arg.slice(alias.length + 1));
                    break;
                }
            }
        }
    }
    return values;
}

function hasArgFlag(aliases: string[], args: string[]): boolean {
    for (const arg of args) {
        if (aliases.includes(arg)) return true;
        for (const alias of aliases) {
            if (arg.startsWith(alias + "=")) return true;
        }
    }
    return false;
}

function getPositionalArgs(args: string[]): string[] {
    const positionals: string[] = [];
    const valueFlags = [
        ["-e", "--env"],
        ["-p", "--port"],
        ["-p", "--plugin"],
        ["-f", "--file"]
    ];
    const booleanFlags = [
        ["-h", "--help"],
        ["-v", "--version"],
        ["-o", "--open"],
        ["-n", "--no-open"],
        ["-b", "--build"]
    ];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (booleanFlags.some((aliases) => aliases.includes(arg))) {
            continue;
        }

        let isValueFlag = false;
        for (const aliases of valueFlags) {
            if (aliases.includes(arg)) {
                const next = args[i + 1];
                if (next !== undefined && !next.startsWith("-")) {
                    i++;
                }
                isValueFlag = true;
                break;
            }
            let matchedPrefix = false;
            for (const alias of aliases) {
                if (arg.startsWith(alias + "=")) {
                    matchedPrefix = true;
                    break;
                }
            }
            if (matchedPrefix) {
                isValueFlag = true;
                break;
            }
        }

        if (isValueFlag) continue;
        if (arg.startsWith("-")) continue;
        positionals.push(arg);
    }
    return positionals;
}

function getExtraArgs(args: string[]): string[] {
    const extraArgs: string[] = [];
    const valueFlags = [
        ["-e", "--env"],
        ["-p", "--port"],
        ["-p", "--plugin"],
        ["-f", "--file"]
    ];
    const booleanFlags = [
        ["-h", "--help"],
        ["-v", "--version"],
        ["-o", "--open"],
        ["-n", "--no-open"],
        ["-b", "--build"]
    ];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (booleanFlags.some((aliases) => aliases.includes(arg))) {
            continue;
        }

        let isValueFlag = false;
        for (const aliases of valueFlags) {
            if (aliases.includes(arg)) {
                const next = args[i + 1];
                if (next !== undefined && !next.startsWith("-")) {
                    i++;
                }
                isValueFlag = true;
                break;
            }
            let matchedPrefix = false;
            for (const alias of aliases) {
                if (arg.startsWith(alias + "=")) {
                    matchedPrefix = true;
                    break;
                }
            }
            if (matchedPrefix) {
                isValueFlag = true;
                break;
            }
        }

        if (isValueFlag) continue;
        extraArgs.push(arg);
    }
    return extraArgs;
}

interface BundleImportResult {
    module: any;
    outputFile: string;
    cleanup: () => Promise<void>;
}

async function bundleAndImportFile(
    file: string,
    startDir: string,
    writeErr: (msg: any) => void,
    extraArgs?: string[]
): Promise<BundleImportResult | null> {
    if (!file || file.trim() === "") {
        writeErr(formatMessage("Error: no file specified.", false));
        return null;
    }

    let resolvedPath: string;
    try {
        resolvedPath = await packages.resolve(file, startDir);
    } catch {
        resolvedPath = file;
    }

    const targetFilePath = path.resolve(resolvedPath);
    let fileExists = false;
    try {
        await fs.promises.stat(targetFilePath);
        fileExists = true;
    } catch {}

    if (!fileExists) {
        writeErr(formatMessage(`Error: file not found: ${file}`, false));
        return null;
    }

    const result = await bundleFile(targetFilePath);
    if (result.Errors?.length > 0) {
        result.Errors.forEach((e: any) => writeErr(formatMessage(e, false)));
        return null;
    }

    const outputFile = result.OutputFiles?.at(0);
    if (!outputFile) {
        writeErr(
            formatMessage(
                `Error: bundling ${file} produced no output files.`,
                false
            )
        );
        return null;
    }

    let absoluteOutputFile = path.resolve(process.cwd(), outputFile);
    if (os.platform() === "win32") {
        // to forward slash
        absoluteOutputFile = absoluteOutputFile.replaceAll("\\", "/");
        // remove drive letter
        absoluteOutputFile =
            absoluteOutputFile.at(1) === ":"
                ? absoluteOutputFile.slice(2)
                : absoluteOutputFile;
    }
    const cleanup = () => fs.promises.rm(outputFile);

    const searchParams = new URLSearchParams();
    searchParams.set("t", Date.now().toString());
    if (extraArgs && extraArgs.length > 0) {
        for (const arg of extraArgs) {
            searchParams.append("argv", arg);
        }
    }
    const importUrl = `${absoluteOutputFile}?${searchParams.toString()}`;

    try {
        const module = await import(importUrl);
        return { module, outputFile: absoluteOutputFile, cleanup };
    } catch (e: any) {
        writeErr(formatMessage(e.stack || e.message || String(e), false));
        await cleanup();
        return null;
    }
}

async function runFile(
    file: string,
    extraArgs: string[],
    writeOut: (msg: any) => void,
    writeErr: (msg: any) => void
): Promise<number> {
    const res = await bundleAndImportFile(
        file,
        process.cwd(),
        writeErr,
        extraArgs
    );
    if (!res) return 1;

    try {
        await waitForInterfaces();
    } finally {
        await res.cleanup();
    }
    return 0;
}

async function runDirectory(
    positionals: string[],
    pluginsArgs: string[],
    buildOnly: boolean,
    noOpen: boolean,
    env: Record<string, string>,
    writeOut: (msg: any) => void,
    writeErr: (msg: any) => void
): Promise<number> {
    const targetDirectory = path.resolve(positionals.at(-1) || ".");

    const buildPlugins: { unregister: () => Promise<void> }[] = [];
    const tempPluginFiles: string[] = [];

    const cleanupPlugins = async () => {
        for (const bp of buildPlugins) {
            try {
                await bp.unregister();
            } catch {}
        }
        for (const tempFile of tempPluginFiles) {
            try {
                await fs.promises.rm(tempFile).catch(() => {});
            } catch {}
        }
    };

    for (const pluginName of pluginsArgs) {
        if (!pluginName) continue;
        const res = await bundleAndImportFile(
            pluginName,
            targetDirectory,
            writeErr
        );
        if (!res) {
            await cleanupPlugins();
            return 1;
        }

        tempPluginFiles.push(res.outputFile);

        try {
            const pluginModule = res.module.default || res.module;
            const registeredPlugin = await plugin.register(
                "build",
                pluginModule
            );
            if (registeredPlugin) {
                buildPlugins.push(registeredPlugin);
            }
        } catch (e: any) {
            writeErr(
                formatMessage(
                    `Error loading plugin ${pluginName}: ${e.message}`,
                    false
                )
            );
            await cleanupPlugins();
            return 1;
        }
    }

    const result = await bundle(targetDirectory);
    if (result.Warnings?.length) {
        result.Warnings.forEach((w: any) => writeErr(formatMessage(w, true)));
    }
    if (result.Errors?.length) {
        result.Errors.forEach((e: any) => writeErr(formatMessage(e)));
        await cleanupPlugins();
        return 1;
    }

    if (buildOnly) {
        writeOut("Build complete.");
        await cleanupPlugins();
        return 0;
    }

    const newCtx = await run({ directory: targetDirectory, env });
    await cleanupPlugins();
    if (!noOpen && typeof newCtx === "number") {
        globalThis.fullstacked.open?.(newCtx);
    }
    return 0;
}

export function validateCommand(command: string | string[]): string[] | null {
    let tokens: string[] = [];
    if (typeof command === "string") {
        tokens = command.trim().split(/\s+/).filter(Boolean);
    } else if (Array.isArray(command)) {
        tokens = [...command];
    }

    let fullstackedIndex = -1;
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const base = token.split(/[/\\]/).pop() || token;
        if (token === "fullstacked" || base === "fullstacked") {
            fullstackedIndex = i;
            break;
        }
    }

    if (fullstackedIndex === -1) {
        return null;
    }

    return tokens.slice(fullstackedIndex);
}

export async function execute(
    command: string | string[],
    opts?: ExecuteOptions
): Promise<number> {
    const stdoutStream = opts?.stdio?.at(1) || createConsoleStream(console.log);
    const stderrStream =
        opts?.stdio?.at(2) || createConsoleStream(console.error);

    const writeOut = getWriter(stdoutStream);
    const writeErr = getWriter(stderrStream);

    // 1. Command Sanitization & Validation
    const tokens = validateCommand(command);
    if (!tokens) {
        writeErr(
            formatMessage(
                "Error: 'fullstacked' command not found in input.",
                false
            )
        );
        return 1;
    }

    const args = tokens.slice(1);

    // 2. Option & Action Parsing
    const showVersion = hasArgFlag(["-v", "--version"], args);
    const showHelp = hasArgFlag(["-h", "--help"], args);

    if (showVersion) {
        writeOut(
            `FullStacked v${version.major}.${version.minor}.${version.patch} (build ${version.build}), branch ${version.branch}, hash ${version.hash.slice(0, 8)}`
        );
        return 0;
    }

    if (showHelp) {
        writeOut(`
Usage: 
  fullstacked [options] [directory]

Description:
  This CLI compiles and runs projects designed for the FullStacked runtime.
  Unlike traditional JS/TS projects with separate frontend and backend layers:
  - NodeJS and Browser APIs are available seamlessly within the same files.
  - ES module syntax.
  - TypeScript support.
  - No HTML files.
  - Start with an entrypoint: index.js(x) or index.ts(x).

Options:
  -v, --version Display the current version
  --port        Define the main starting port (defaults to 9000)
  -p, --plugin  Specify a plugin for the build process (can be used multiple times)
  -e, --env     Define environment variables in KEY=VALUE format (can be used multiple times)
  -o, --open    Directly open the browser
  -b, --build   Only bundle the project, don't run it afterward
  -f, --file    Bundle and execute a single script file
  -h, --help    Display this help message

Directory:
  The directory to bundle (defaults to ".")
        `);
        return 0;
    }

    const fileFlags = findArgValues(["-f", "--file"], args);
    const file = fileFlags.length > 0 ? fileFlags[0] : undefined;
    const buildOnly = hasArgFlag(["-b", "--build"], args);
    const noOpen = hasArgFlag(["-n", "--no-open"], args);
    const envArgs = findArgValues(["-e", "--env"], args);
    const pluginsArgs = findArgValues(["-p", "--plugin"], args);
    const positionals = getPositionalArgs(args);

    const env: Record<string, string> = {};
    for (const val of envArgs) {
        const index = val.indexOf("=");
        if (index !== -1) {
            env[val.slice(0, index)] = val.slice(index + 1);
        } else if (val) {
            env[val] = "";
        }
    }

    if (file) {
        const extraArgs = getExtraArgs(args);
        return runFile(file, extraArgs, writeOut, writeErr);
    }

    return runDirectory(
        positionals,
        pluginsArgs,
        buildOnly,
        noOpen,
        env,
        writeOut,
        writeErr
    );
}

export { getActiveInterfaces, waitForInterfaces } from "../readline/interface.ts";

const fullstacked = {
    execute,
    validateCommand,
    getActiveInterfaces,
    waitForInterfaces
};

export default fullstacked;
