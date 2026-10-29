import { suite } from "node:test";
import * as nodeStringDecoder from "node:string_decoder";
import * as libStringDecoder from "../../../core/internal/bundle/lib/string_decoder/index.ts";
import * as libBuffer from "../../../core/internal/bundle/lib/buffer/index.ts";
import { sameFor } from "../common.ts";

type Decoder = typeof nodeStringDecoder.StringDecoder;
type Env = { StringDecoder: Decoder; Buffer: typeof Buffer };
const shim: Env = {
    StringDecoder: (libStringDecoder as any).StringDecoder,
    Buffer: (libBuffer as any).Buffer
};
const node: Env = { StringDecoder: nodeStringDecoder.StringDecoder, Buffer };
const same = sameFor<Env>("string_decoder", shim, node);

// feeds `bytes` in chunks of `size` and returns every write and the end
function chunked(env: Env, encoding: string, bytes: number[], size: number) {
    const decoder = new env.StringDecoder(encoding as BufferEncoding);
    const out: string[] = [];
    for (let i = 0; i < bytes.length; i += size) {
        out.push(decoder.write(env.Buffer.from(bytes.slice(i, i + size))));
    }
    out.push(decoder.end());
    return out;
}

const UTF8 = [...Buffer.from("aé€😀b中")];
const INVALID_UTF8 = [
    0xe2, 0x82, 0x41, 0xf0, 0x9f, 0x98, 0xc3, 0xff, 0xed, 0xa0, 0x80, 0x62
];
const UTF16 = [...Buffer.from("a😀é", "utf16le")];
const BINARY = Array.from({ length: 20 }, (_, i) => (i * 37) & 0xff);

suite("shim string_decoder", () => {
    for (const size of [1, 2, 3, 5]) {
        same(`utf8 in chunks of ${size}`, (env) =>
            chunked(env, "utf8", UTF8, size)
        );
        same(`utf8 invalid sequences in chunks of ${size}`, (env) =>
            chunked(env, "utf8", INVALID_UTF8, size)
        );
        same(`utf16le in chunks of ${size}`, (env) =>
            chunked(env, "utf16le", UTF16, size)
        );
        same(`base64 in chunks of ${size}`, (env) =>
            chunked(env, "base64", BINARY, size)
        );
        same(`base64url in chunks of ${size}`, (env) =>
            chunked(env, "base64url", BINARY, size)
        );
        same(`hex in chunks of ${size}`, (env) =>
            chunked(env, "hex", BINARY, size)
        );
        same(`latin1 in chunks of ${size}`, (env) =>
            chunked(env, "latin1", BINARY, size)
        );
    }
    same("utf8 truncated at end()", (env) =>
        chunked(env, "utf8", [0x61, 0xf0, 0x9f, 0x98], 4)
    );
    same("utf16le with an odd byte at end()", (env) =>
        chunked(env, "utf16le", [0x61, 0x00, 0x62], 3)
    );
    same("end(buffer)", ({ StringDecoder, Buffer }) => {
        const decoder = new StringDecoder("utf8");
        return [
            decoder.write(Buffer.from([0xe2])),
            decoder.end(Buffer.from([0x82, 0xac]))
        ];
    });
    same("default encoding and aliases", ({ StringDecoder }) =>
        [undefined, "UTF-8", "ucs2", "binary", "utf-16le"].map(
            (e) => (new StringDecoder(e as BufferEncoding) as any).encoding
        )
    );
    same(
        "unknown encoding",
        ({ StringDecoder }) => new StringDecoder("nope" as BufferEncoding)
    );
    same("write(string) and write(Uint8Array)", ({ StringDecoder }) => {
        const decoder = new StringDecoder("utf8");
        return [
            decoder.write("text" as any),
            decoder.write(new Uint8Array([0xc3, 0xa9]) as any)
        ];
    });
});
