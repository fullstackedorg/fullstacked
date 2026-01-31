import fs from "node:fs";
import path from "node:path";

const tsgoDirectory = path.resolve("..", "typescript-go");

const toPatch = [
    {
        // /dev/null/infered crashes everything
        file: path.resolve(tsgoDirectory, "internal", "project", "project.go"),
        replace: [
            {
                from: `inferredProjectName = "/dev/null/inferred"`,
                to__: `inferredProjectName = ".inferred"`
            }
        ]
    },
    {
        // fix invalid utf8 panic
        file: path.resolve(tsgoDirectory, "internal", "ls", "signaturehelp.go"),
        replace: [
            {
                from: `Label:         displayParts.String(),`,
                to__: `Label:         strings.ToValidUTF8(displayParts.String(), ""),`
            },
            {
                from: `Label:         display.String(),`,
                to__: `Label:         strings.ToValidUTF8(display.String(), ""),`
            }
        ]
    },
    {
        // ios isCaseSensitive
        file: path.resolve(tsgoDirectory, "internal", "vfs", "osvfs", "os.go"),
        replace: [
            {
                from: `if runtime.GOOS == "windows" {`,
                to__: `if runtime.GOOS == "windows" || runtime.GOOS == "ios" {`
            }
        ]
    }
];

function patch() {
    toPatch.forEach((p) => {
        let contents = fs.readFileSync(p.file, { encoding: "utf8" });
        p.replace.forEach(({ from, to__ }) => {
            if (!contents.includes(from) && !contents.includes(to__)) {
                throw `Cannot find text to replace\n${p.file}\n[${from}]\n[${to__}] `;
            }
            contents = contents.replace(from, to__);
        });
        fs.writeFileSync(p.file, contents);
    });

    // put tsgo module into the codebase
    const sourceFile = path.resolve("typescript-go-patch", "module", "tsgo.go");
    const outDir = path.resolve(tsgoDirectory, "cmd", "module");
    const outFile = path.resolve(outDir, "tsgo.go");

    fs.mkdirSync(outDir, { recursive: true });
    fs.cpSync(sourceFile, outFile);
}

if (fs.readdirSync(tsgoDirectory).length > 0) {
    patch();
}
