import * as sass from "sass";

export async function buildSASS(entryData: string, opts: {
    canonicalize: (filePath: string) => URL | Promise<URL>,
    load: (url: URL) => string | Promise<string>
}) {
    try {
        const { css } = await sass.compileStringAsync(entryData, {
            importer: {
                load: async url => ({
                    syntax: url.pathname.endsWith(".sass")
                        ? "indented"
                        : url.pathname.endsWith(".scss")
                            ? "scss"
                            : "css",
                    contents: await opts.load(url)
                }),
                canonicalize: opts.canonicalize
            }
        });
        return {
            css,
            errors: []
        };
    } catch (e) {
        console.log(e)
        const File = e.span.url?.pathname;
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
