import { createTool } from "@fullstacked/ai-agent";
import { z } from "zod";
import type fsType from "../../fs";
import _fs from "fs";

const fs: typeof fsType = _fs;

type ToolFSOptions = {
    baseDirectory: string;
};

export function createToolFS(opts?: Partial<ToolFSOptions>) {
    let basePath = opts?.baseDirectory || "";

    if (basePath !== "" && !basePath.endsWith("/")) {
        basePath += "/";
    }

    const fixPath = (path: string) => basePath + path;

    return [
        createTool({
            name: "CreateDir",
            description: "Create a directory.",
            schema: z.object({
                path: z.string()
            }),
            fn: async ({ path }) => {
                const success = await fs.mkdir(fixPath(path));
                return success
                    ? `Successfully created directory ${path}.`
                    : `Failed to create directory ${path}.`;
            },
            message: ({ path }) => `Creating directory \`${path}\``
        }),
        createTool({
            name: "ListFiles",
            description: "List files in a directory.",
            schema: z.object({
                path: z.string()
            }),
            fn: ({ path }) => fs.readdir(fixPath(path)),
            message: ({ path }) => `Listing files at \`${path}\``
        }),
        createTool({
            name: "ReadFile",
            description: "Read the content of a file.",
            schema: z.object({
                path: z.string()
            }),
            fn: ({ path }) => fs.readFile(fixPath(path), { encoding: "utf8" }),
            message: ({ path }) => `Reading file at \`${path}\``
        }),
        createTool({
            name: "WriteFile",
            description: "Write content to file.",
            schema: z.object({
                path: z.string(),
                contents: z.string()
            }),
            fn: async ({ path, contents }) => {
                const success = await fs.writeFile(fixPath(path), contents);
                return success
                    ? `Successfully written ${contents.length} characters to ${path}.`
                    : `Failed to write to ${path}.`;
            },
            message: ({ path }) => `Writing to \`${path}\``
        })
    ];
}
