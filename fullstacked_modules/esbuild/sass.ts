import * as sass from "sass";
import type { Message } from "esbuild";
import { Project } from "../../editor/types";

export async function buildSASS(
    fs: {
        mkdir(dir: string): Promise<boolean>;
        writeFile(path: string, data: string): Promise<boolean>;
        readdir(dir: string): Promise<string[]>;
        readFile(path: string, options: any): Promise<string>;
    },
    project?: Project
): Promise<Partial<Message>> {
    const baseDirectory = project?.id || ".";

    const writeOutputCSS = async (css: string) => {
        const buildDirectory = baseDirectory
            ? `${baseDirectory}/.build`
            : ".build";
        await fs.mkdir(buildDirectory);
        await fs.writeFile(buildDirectory + "/index.css", css);
    };

    const contents = await fs.readdir(baseDirectory);
    const entryPointSASS = contents.find(
        (item) => item === "index.sass" || item === "index.scss"
    );

    // check for css file and write to output
    // esbuild will pick it up and merge with css in js
    if (!entryPointSASS) {
        const entryPointCSS = contents.find((item) => item === "index.css");
        if (entryPointCSS) {
            const filePath = baseDirectory
                ? `${baseDirectory}/${entryPointCSS}`
                : entryPointCSS;
            // TODO: fs.copyFile
            await writeOutputCSS(
                await fs.readFile(filePath, {
                    encoding: "utf8"
                })
            );
        } else {
            await writeOutputCSS("");
        }

        return;
    }

    const filePath = baseDirectory
        ? `${baseDirectory}/${entryPointSASS}`
        : entryPointSASS;
    const entryData = await fs.readFile(filePath, {
        encoding: "utf8"
    });
    let result: sass.CompileResult;
    try {
        result = await sass.compileStringAsync(entryData, {
            importer: {
                load: async (url) => {
                    const filePath = `${baseDirectory}${url.pathname}`;
                    const contents = await fs.readFile(filePath, {
                        encoding: "utf8"
                    });
                    return {
                        syntax: filePath.endsWith(".sass")
                            ? "indented"
                            : filePath.endsWith(".scss")
                              ? "scss"
                              : "css",
                        contents
                    };
                },
                canonicalize: (path) => new URL(path, "http://localhost")
            }
        });
    } catch (e) {
        const error = e as unknown as sass.Exception;
        const file =
            baseDirectory + (error.span.url?.pathname || "/" + entryPointSASS);
        const line = error.span.start.line + 1;
        const column = error.span.start.column;
        const length = error.span.text.length;
        return {
            text: error.message,
            location: {
                file,
                line,
                column,
                length,
                namespace: "SASS",
                lineText: error.message,
                suggestion: ""
            }
        };
    }

    await writeOutputCSS(result.css);
    return null;
}
