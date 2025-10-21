import * as sass from "sass";

export function buildSASS(entryPoint: string) {
    try {
        const { css } = sass.compile(entryPoint);
        return {
            css,
            errors: []
        };
    } catch (e) {
        const File = e.span.url?.pathname || "/" + entryPoint;
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
