import * as sass from "sass";

export async function buildSASS(
    entryPoint: string,
    opts: {
        projectId?: string;
        canonicalize: (filePath: string) => URL | Promise<URL>;
        load: (url: URL) => string | Promise<string>;
    }
) {
    try {
        const { css } = await sass.compileStringAsync(
            await opts.load(await opts.canonicalize(entryPoint)),
            {
                syntax: entryPoint.endsWith(".sass")
                    ? "indented"
                    : entryPoint.endsWith(".scss")
                      ? "scss"
                      : "css",
                importer: {
                    load: async (url) => ({
                        syntax: url.pathname.endsWith(".sass")
                            ? "indented"
                            : url.pathname.endsWith(".scss")
                              ? "scss"
                              : "css",
                        contents: await opts.load(url)
                    }),
                    canonicalize: opts.canonicalize
                }
            }
        );
        return {
            css,
            errors: []
        };
    } catch (e) {
        let File = e.span.url?.pathname || entryPoint;
        if (File.startsWith("/")) {
            File = File.slice(1);
        }
        if (opts.projectId) {
            File = opts.projectId + "/" + File;
        }
        const Line = e.span.start.line + 1;
        const Column = e.span.start.column;
        const Length = e.span.text.length;
        return {
            css: "",
            errors: [
                {
                    Location: {
                        File,
                        Line,
                        Column,
                        Length,
                        Namespace: "SASS"
                    },
                    Text: e.message
                }
            ]
        };
    }
}
