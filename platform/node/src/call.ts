import ffi from "ffi-rs";
import path from "path";
import os from "os";

const platform = os.platform();
const binDirectory = path.resolve(process.cwd(), "..", "..", "core", "bin");
const libBinary =
    platform === "darwin"
        ? "macos-x86_64"
        : platform === "win32"
          ? "win-x64.dll"
          : platform === "linux"
            ? "linux-x86_64"
            : null;

if (!libBinary) {
    throw "unknown platform";
}

const libPath = path.resolve(binDirectory, libBinary);

const library = "fullstacked";
ffi.open({
    library: library,
    path: libPath
});

ffi.open({
    library: library,
    path: libPath
});

export function setDirectories(directories: {
    root: string;
    config: string;
    editor: string;
}) {
    return ffi.load({
        errno: false,
        library,
        funcName: "directories",
        paramsType: [
            ffi.DataType.String,
            ffi.DataType.String,
            ffi.DataType.String
        ],
        retType: ffi.DataType.Void,
        paramsValue: [directories.root, directories.config, directories.editor],
        runInNewThread: true,
        freeResultMemory: true
    });
}

export function setCallback(
    cb: (projectId: string, messageType: string, message: string) => void
) {
    const funcExternal = ffi.createPointer({
        paramsType: [
            ffi.funcConstructor({
                paramsType: [
                    ffi.DataType.String,
                    ffi.DataType.String,
                    ffi.DataType.String
                ],
                retType: ffi.DataType.Void
            })
        ],
        paramsValue: [cb]
    });

    return ffi.load({
        library,
        funcName: "callback",
        retType: ffi.DataType.Void,
        paramsType: [ffi.DataType.External],
        paramsValue: ffi.unwrapPointer(funcExternal),
        runInNewThread: true,
        freeResultMemory: true
    });
}

export async function callLib(payload: Uint8Array) {
    const responsePtr = ffi.createPointer({
        paramsType: [
            ffi.arrayConstructor({
                type: ffi.DataType.U8Array,
                length: 0
            })
        ],
        paramsValue: [new Uint8Array()]
    });

    const responseLength = await ffi.load({
        errno: false,
        library,
        funcName: "call",
        paramsType: [
            ffi.DataType.U8Array,
            ffi.DataType.I32,
            ffi.DataType.External
        ],
        retType: ffi.DataType.I32,
        paramsValue: [payload, payload.byteLength, responsePtr.at(0)],
        runInNewThread: true,
        freeResultMemory: true
    });

    const uint8arrayConstructor = ffi.arrayConstructor({
        type: ffi.DataType.U8Array,
        length: responseLength
    });

    const data = ffi
        .restorePointer({
            retType: [uint8arrayConstructor],
            paramsValue: responsePtr
        })
        .at(0) as unknown as Buffer;

    ffi.load({
        errno: false,
        library,
        funcName: "freePtr",
        paramsType: [ffi.DataType.External],
        retType: ffi.DataType.Void,
        paramsValue: [ffi.unwrapPointer(responsePtr).at(0)],
        runInNewThread: true,
        freeResultMemory: true
    });

    ffi.freePointer({
        paramsType: [uint8arrayConstructor],
        paramsValue: responsePtr,
        pointerType: ffi.PointerType.RsPointer
    });

    return new Uint8Array(data.buffer);
}
