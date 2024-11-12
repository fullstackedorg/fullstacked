import { EditorView, keymap } from "@codemirror/view";
import { createElement, ElementComponent } from "../../components/element";
import { createRefresheable } from "../../components/refresheable";
import { Store } from "../../store";
import { ipcEditor } from "../../store/ipc";
import prettyBytes from "pretty-bytes";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import {
    linter,
    lintGutter
} from "@codemirror/lint";
import prettier from "prettier";
import prettierPluginHTML from "prettier/plugins/html";
import prettierPluginCSS from "prettier/plugins/postcss";
import prettierPluginMD from "prettier/plugins/markdown";
import prettierPluginEstree from "prettier/plugins/estree";
import prettierPluginTypeScript from "prettier/plugins/typescript";
import { EditorSelection, SelectionRange } from "@codemirror/state";

const tabWidth = 4;

window.addEventListener("keydown", applyPrettierToCurrentFocusFile);

export function CodeEditor() {
    const container = createElement("div");

    Store.editor.codeEditor.openedFiles.subscribe(createViews);

    const refresheable = createRefresheable(focusFile);
    Store.editor.codeEditor.focusedFile.subscribe(refresheable.refresh);

    container.ondestroy = () => {
        Store.editor.codeEditor.openedFiles.unsubscribe(createViews);
        Store.editor.codeEditor.focusedFile.unsubscribe(refresheable.refresh);
    };
    container.append(refresheable.element);
    return container;
}

type View = {
    element: ElementComponent;
    editorView?: EditorView;
};

const views = new Map<string, View>();

function createViews(filesPaths: Set<string>) {
    const pathToClose = new Set<string>();
    for (const path of views.keys()) {
        if (filesPaths.has(path)) continue;
        pathToClose.add(path);
    }
    pathToClose.forEach(path => {
        views.get(path).editorView?.destroy();
        views.delete(path);
        if (focusedViewPath === path) {
            Store.editor.codeEditor.focusFile(null);
        }
    });
    filesPaths.forEach(path => {
        if (views.get(path)) return;
        focusFile(path);
    });
}

let focusedViewPath: string;
function focusFile(path: string) {
    focusedViewPath = path;

    if (!path) return createElement("div");

    let view = views.get(path);

    if (!view) {
        view = createView(path);
        views.set(path, view);
    }

    return view.element;
}

function createView(filePath: string): View {
    const fileExtension = filePath.split(".").pop().toLowerCase();
    if (Object.values(BINARY_Ext).find((ext) => ext === fileExtension)) {
        return createBinaryView(filePath);
    } else if (Object.values(IMAGE_Ext).find((ext) => ext === fileExtension)) {
        return createImageView(filePath);
    }

    return createViewEditor(filePath);
}

function createBinaryView(filePath: string) {
    const container = createElement("div");
    container.classList.add("binary-view");

    ipcEditor.fs
        .stat(filePath)
        .then((stats) => (container.innerText = prettyBytes(stats.size)));

    return { element: container };
}

function createImageView(filePath: string) {
    const container = createElement("div");
    container.classList.add("image-view");
    const img = document.createElement("img");
    container.append(img);

    let imageURL: string;

    container.ondestroy = () => {
        URL.revokeObjectURL(imageURL);
    };

    ipcEditor.fs.readFile(filePath).then((imageData) => {
        const blob = new Blob([imageData]);
        imageURL = URL.createObjectURL(blob);
        img.src = imageURL;
    });

    return { element: container };
}

const defaultExtensions = [
    basicSetup,
    oneDark,
    keymap.of([indentWithTab]),
    indentUnit.of(new Array(tabWidth + 1).join(" "))
];

function createViewEditor(filePath: string) {
    const container = createElement("div");

    const view: View = {
        element: container,
        editorView: null
    };

    ipcEditor.fs.readFile(filePath, { encoding: "utf8" }).then(async (content) => {
        view.editorView = new EditorView({
            doc: content,
            extensions: [
                ...defaultExtensions,
                ...(await languageExtensions(filePath)),
            ],
            parent: container
        });
    });

    return view;
}


async function languageExtensions(filePath: string) {
    const fileExtension = filePath.split(".").pop().toLowerCase() as UTF8_Ext;

    switch (fileExtension) {
        case UTF8_Ext.JAVASCRIPT:
        case UTF8_Ext.JAVASCRIPT_C:
        case UTF8_Ext.JAVASCRIPT_M:
        case UTF8_Ext.JAVASCRIPT_X:
        case UTF8_Ext.TYPESCRIPT:
        case UTF8_Ext.TYPESCRIPT_X:
            return loadJsTsExtensions(filePath);
        case UTF8_Ext.SVG:
        case UTF8_Ext.HTML:
            const langHTML = await import("@codemirror/lang-html");
            return [langHTML.html()];
        case UTF8_Ext.MARKDOWN:
            const langMD = await import("@codemirror/lang-markdown");
            return [langMD.markdown()];
        case UTF8_Ext.JSON:
            const langJSON = await import("@codemirror/lang-json");
            return [langJSON.json(), linter(langJSON.jsonParseLinter())];
        case UTF8_Ext.CSS:
            const langCSS = await import("@codemirror/lang-css");
            return [langCSS.css()];
        case UTF8_Ext.SASS:
        case UTF8_Ext.SCSS:
            const langSASS = await import("@codemirror/lang-sass");
            return [
                langSASS.sass({
                    indented: fileExtension === UTF8_Ext.SASS
                })
            ];
        case UTF8_Ext.LIQUID:
            const langLiquid = await import("@codemirror/lang-liquid");
            return [langLiquid.liquid(), langLiquid.closePercentBrace];
    }

    return [];
}

async function loadJsTsExtensions(filePath: string) {
    const extensions = [];
    const fileExtension = filePath.split(".").pop().toLowerCase() as UTF8_Ext;
    const langJs = await import("@codemirror/lang-javascript");

    const jsDefaultExtension = langJs.javascript({
        typescript: typescriptExtensions.includes(fileExtension),
        jsx: fileExtension.endsWith("x")
    });

    extensions.push(jsDefaultExtension, lintGutter());

    if (javascriptExtensions.includes(fileExtension)) {
        const jsAutocomplete = langJs.javascriptLanguage.data.of({
            autocomplete: langJs.scopeCompletionSource(globalThis)
        });
        extensions.push(jsAutocomplete);
    }
    // load typescript
    else {
        // extensions.push(...(await loadTypeScript(filePath)));
    }

    return extensions;
}


const prettierPlugins = [
    prettierPluginHTML,
    prettierPluginCSS,
    prettierPluginMD,
    prettierPluginEstree,
    prettierPluginTypeScript
]


async function applyPrettierToCurrentFocusFile(e: KeyboardEvent) {
    if (e.key !== "s" || (!e.metaKey && !e.ctrlKey)) return;

    e.preventDefault();

    const view = views.get(focusedViewPath);
    if (!view?.editorView) return;

    const fileExtension = focusedViewPath.split(".").pop().toLowerCase() as UTF8_Ext;
    if (!prettierSupport.includes(fileExtension)) return;

    let filepath = focusedViewPath
    if(fileExtension === UTF8_Ext.SVG) {
        filepath = filepath.slice(0, 0 - ".svg".length) + ".html";
    }
    
    const formatted = await prettier.format(
        view.editorView.state.doc.toString(),
        {
            filepath,
            plugins: prettierPlugins,
            tabWidth
        }
    );

    let selection = view.editorView.state.selection;

    let range = selection.ranges?.at(0)
    if (range?.from > formatted.length) {
        selection = selection.replaceRange(EditorSelection.range(formatted.length, range.to), 0)
        range = selection.ranges?.at(0)
    }
    if (range?.to > formatted.length) {
        selection = selection.replaceRange(EditorSelection.range(range.from, formatted.length), 0)
    }

    view.editorView.dispatch({
        changes: {
            from: 0,
            to: view.editorView.state.doc.length,
            insert: formatted
        },
        selection
    });
}


enum UTF8_Ext {
    JAVASCRIPT = "js",
    JAVASCRIPT_X = "jsx",
    JAVASCRIPT_M = "mjs",
    JAVASCRIPT_C = "cjs",
    TYPESCRIPT = "ts",
    TYPESCRIPT_X = "tsx",
    SVG = "svg",
    TEXT = "txt",
    MARKDOWN = "md",
    YML = "yml",
    YAML = "yaml",
    HTML = "html",
    CSS = "css",
    JSON = "json",
    SASS = "sass",
    SCSS = "scss",
    LIQUID = "liquid"
}

enum IMAGE_Ext {
    PNG = "png",
    JPG = "jpg",
    JPEG = "jpeg",
    GIF = "gif",
    WEBP = "webp",
    BMP = "bmp"
}

enum BINARY_Ext {
    ZIP = "zip"
}

const javascriptExtensions = [
    UTF8_Ext.JAVASCRIPT,
    UTF8_Ext.JAVASCRIPT_C,
    UTF8_Ext.JAVASCRIPT_M,
    UTF8_Ext.JAVASCRIPT_X
];

const typescriptExtensions = [UTF8_Ext.TYPESCRIPT, UTF8_Ext.TYPESCRIPT_X];

const jsTsExtensions = [...javascriptExtensions, ...typescriptExtensions];

const prettierSupport = [
    ...jsTsExtensions,
    UTF8_Ext.HTML,
    UTF8_Ext.SVG,
    UTF8_Ext.JSON,
    UTF8_Ext.MARKDOWN,
    UTF8_Ext.CSS,
    UTF8_Ext.SASS,
    UTF8_Ext.SCSS
]

export type FileError = {
    line: number;
    col: number;
    length: number;
    message: string;
};