// The ssh2 algorithm matrix (improvements/shim/plan.md 4.1): every cipher, MAC, kex and
// host key type ssh2 supports, each forced alone with the `algorithms`
// option against the openssh test container. Node's ssh2 (node:crypto) tells
// what the server accepts; the webview's (the crypto shim) must accept the
// same, test/net/integration.ts compares the two.

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { NodeSSH } from "node-ssh";

const require = createRequire(import.meta.url);
const constants = require("ssh2/lib/protocol/constants.js");

export type AlgorithmCase = {
    name: string;
    algorithms: Record<string, string[]>;
    // run `seq 1 <lines>` instead of `echo matrix`: output over several
    // packets (the compression cases)
    lines?: number;
};

// what a case's command must print
export function matrixCommand(c: { lines?: number }) {
    return c.lines ? `seq 1 ${c.lines}` : "echo matrix";
}

export function matrixOutputOk(c: { lines?: number }, stdout: string) {
    if (!c.lines) return stdout.trim() === "matrix";
    const lines = stdout.trim().split("\n");
    return lines.length === c.lines && lines[c.lines - 1] === String(c.lines);
}

export type MatrixResult = Record<string, "ok" | string>;

// a cipher with its own MAC (GCM, chacha20-poly1305) ignores the MAC list,
// so each MAC is tried with aes128-ctr
export function algorithmMatrix(): AlgorithmCase[] {
    const cases: AlgorithmCase[] = [];
    for (const cipher of constants.SUPPORTED_CIPHER as string[]) {
        cases.push({
            name: `cipher ${cipher}`,
            algorithms: { cipher: [cipher] }
        });
    }
    for (const hmac of constants.SUPPORTED_MAC as string[]) {
        cases.push({
            name: `mac ${hmac}`,
            algorithms: { cipher: ["aes128-ctr"], hmac: [hmac] }
        });
    }
    for (const kex of constants.SUPPORTED_KEX as string[]) {
        cases.push({ name: `kex ${kex}`, algorithms: { kex: [kex] } });
    }
    for (const key of constants.SUPPORTED_SERVER_HOST_KEY as string[]) {
        cases.push({
            name: `host key ${key}`,
            algorithms: { serverHostKey: [key] }
        });
    }
    // OpenSSH flushes each packet with Z_PARTIAL_FLUSH; since 7.4 it only
    // offers zlib@openssh.com (compression after authentication)
    for (const compress of constants.SUPPORTED_COMPRESSION as string[]) {
        if (compress === "none") continue;
        cases.push({
            name: `compress ${compress}`,
            algorithms: { compress: [compress] },
            lines: 20000
        });
    }
    // SSH_MATRIX=<text> keeps the cases whose name contains it ("all": all)
    const filter = process.env.SSH_MATRIX;
    return filter && filter !== "all"
        ? cases.filter((c) => c.name.includes(filter))
        : cases;
}

// Opens the openssh container (linuxserver/openssh-server) to every
// algorithm both it and ssh2 support, and turns off PerSourcePenalties
// (OpenSSH 9.8+), which blocks a client after a few failed key exchanges
// and would fail every case after the first refused one.
export function prepareServer(container: string) {
    const sh = (cmd: string) =>
        execFileSync("docker", ["exec", container, "sh", "-c", cmd], {
            encoding: "utf8"
        });
    const both = (query: string, ours: string[]) =>
        sh(`ssh -Q ${query}`)
            .split("\n")
            .map((s) => s.trim())
            .filter((s) => ours.includes(s))
            .join(",");
    const lines = [
        "PerSourcePenalties no",
        // the forwardOut feature case
        "AllowTcpForwarding yes",
        // the default ("delayed"), stated for the compression cases
        "Compression yes",
        `Ciphers ${both("cipher", constants.SUPPORTED_CIPHER)}`,
        `MACs ${both("mac", constants.SUPPORTED_MAC)}`,
        `KexAlgorithms ${both("kex", constants.SUPPORTED_KEX)}`,
        `HostKeyAlgorithms ${both("key-sig", constants.SUPPORTED_SERVER_HOST_KEY)}`
    ];
    // first: sshd keeps the first value of a keyword, and an appended
    // line could land in a Match block
    const config = "/config/sshd/sshd_config";
    sh(
        `{ printf '%s\\n' ${lines.map((l) => `'${l}'`).join(" ")}; cat ${config}; } > ${config}.new && mv ${config}.new ${config} && /usr/sbin/sshd.pam -t -f ${config} && kill -HUP $(pgrep -o -f /usr/sbin/sshd)`
    );
}

// The keys of the feature cases (test/net/sample/ssh): generated in the
// container by ssh-keygen, in the formats ssh2 parses (OpenSSH, PEM,
// encrypted with bcrypt-pbkdf), authorized for testuser.
export type SshKey = { key: string; passphrase?: string };

export function prepareKeys(container: string): Record<string, SshKey> {
    const sh = (cmd: string) =>
        execFileSync("docker", ["exec", container, "sh", "-c", cmd], {
            encoding: "utf8"
        });
    const kinds: Record<string, [string, string?]> = {
        ed25519: ["-t ed25519"],
        "rsa (PEM)": ["-t rsa -b 2048 -m PEM"],
        "rsa (OpenSSH)": ["-t rsa -b 2048"],
        "ecdsa nistp256": ["-t ecdsa -b 256"],
        "ed25519 with passphrase": ["-t ed25519", "secret"]
    };
    const keys: Record<string, SshKey> = {};
    Object.entries(kinds).forEach(([name, [args, passphrase]], i) => {
        const file = `/tmp/key${i}`;
        sh(
            `rm -f ${file} ${file}.pub && ssh-keygen -q ${args} -N '${passphrase ?? ""}' -f ${file} && cat ${file}.pub >> /config/.ssh/authorized_keys`
        );
        keys[name] = { key: sh(`cat ${file}`), passphrase };
    });
    sh(
        "chown testuser:testuser /config/.ssh/authorized_keys && chmod 600 /config/.ssh/authorized_keys"
    );
    return keys;
}

// one connection, one command; "ok" or the error message
export async function trySsh(
    port: number,
    c: Pick<AlgorithmCase, "algorithms" | "lines">,
    sock?: unknown
): Promise<string> {
    const { algorithms } = c;
    const ssh = new NodeSSH();
    try {
        await ssh.connect({
            ...(sock ? { sock: sock as any } : {}),
            host: "127.0.0.1",
            port,
            username: "testuser",
            password: "testpass",
            readyTimeout: 30000,
            algorithms
        });
        const result = await ssh.execCommand(matrixCommand(c));
        return matrixOutputOk(c, result.stdout)
            ? "ok"
            : `unexpected output: ${result.stdout.slice(0, 200)}`;
    } catch (e) {
        return (e as Error)?.message ?? String(e);
    } finally {
        ssh.dispose();
    }
}

export async function runMatrix(
    port: number,
    makeSocket?: () => Promise<unknown>
): Promise<MatrixResult> {
    const results: MatrixResult = {};
    for (const c of algorithmMatrix()) {
        results[c.name] = await trySsh(
            port,
            c,
            makeSocket ? await makeSocket() : undefined
        );
    }
    return results;
}
