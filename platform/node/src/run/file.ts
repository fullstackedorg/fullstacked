import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { bundleFile } from "../../../../core/internal/bundle/lib/bundle/index.ts";
import WebSocketCore from "../../../../core/internal/bundle/lib/websocket/index.ts";

export async function runFile(
    positionalArgs: string[],
    end: (code: number) => void
) {
    if (positionalArgs.length === 0) {
        console.error("Error: no file specified.");
        end(1);
    }
    const scriptFile = positionalArgs[0];
    const targetFilePath = path.resolve(scriptFile);
    if (!fs.existsSync(targetFilePath)) {
        console.error(`Error: file not found: ${scriptFile}`);
        end(1);
    }

    try {
        const result = await bundleFile(
            path.relative(process.cwd(), targetFilePath)
        );
        if (result.Errors?.length > 0) {
            result.Errors.forEach((e: any) => {
                if (e.text) {
                    let out = e.text;
                    if (e.location) {
                        out += `\n    at ${e.location.file}:${e.location.line}:${e.location.column}`;
                    }
                    console.error(out);
                } else {
                    console.error(e);
                }
            });
            end(1);
        }

        const outputFile = result.OutputFiles?.at(0);
        if (!outputFile) {
            console.error("Error: no output file generated.");
            end(1);
        }

        const absoluteOutputFile = path.resolve(outputFile);

        const cleanup = () => {
            try {
                const resolved = require.resolve(absoluteOutputFile);
                delete require.cache[resolved];
            } catch {}
            return fs.promises.rm(absoluteOutputFile).catch(() => {});
        };

        // Prepare process.argv for the script
        process.argv = [
            process.argv[0],
            targetFilePath,
            ...positionalArgs.slice(1)
        ];

        const originalWebSocket = globalThis.WebSocket;
        if (!globalThis.fullstacked) {
            globalThis.fullstacked = {} as any;
        }
        if (originalWebSocket && !globalThis.fullstacked.WebSocket) {
            globalThis.fullstacked.WebSocket = originalWebSocket;
        }
        globalThis.WebSocket = WebSocketCore as any;
        if (typeof (globalThis as any).window === "undefined") {
            (globalThis as any).window = globalThis;
        }

        try {
            await import(pathToFileURL(absoluteOutputFile).href);
        } catch (e: any) {
            console.error(e.stack || e.message || String(e));
            await cleanup();
            end(1);
        } finally {
            if (originalWebSocket) {
                globalThis.WebSocket = originalWebSocket;
            } else {
                delete (globalThis as any).WebSocket;
            }
        }

        await cleanup();
        end(0);
    } catch (e: any) {
        console.error(`Error: ${e.message}`);
        end(1);
    }
}
