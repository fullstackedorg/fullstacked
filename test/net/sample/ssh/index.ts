import { NodeSSH } from "node-ssh";
import { Buffer } from "buffer";
import crypto from "crypto";

const params = new URLSearchParams(window.location.search);
const port = parseInt(params.get("port") || "2222", 10);

// test/net/ssh-algorithms.ts matrixCommand and matrixOutputOk
const matrixCommand = (lines?: number) =>
    lines ? `seq 1 ${lines}` : "echo matrix";
function matrixOutputOk(stdout: string, lines?: number) {
    if (!lines) return stdout.trim() === "matrix";
    const out = stdout.trim().split("\n");
    return out.length === lines && out[lines - 1] === String(lines);
}

async function connect(algorithms?: Record<string, string[]>, lines?: number) {
    const ssh = new NodeSSH();
    try {
        await ssh.connect({
            host: "127.0.0.1",
            port: port,
            username: "testuser",
            password: "testpass",
            readyTimeout: 30000,
            ...(algorithms ? { algorithms } : {})
        });
        return await ssh.execCommand(
            algorithms ? matrixCommand(lines) : "echo hello world"
        );
    } finally {
        ssh.dispose();
    }
}

async function run() {
    try {
        const result = await connect();

        if (result.stdout.trim() === "hello world") {
            document.body.innerText = "SUCCESS";
        } else {
            document.body.innerText = `FAILED: ${result.stdout}`;
        }
    } catch (e: any) {
        document.body.innerText = `ERROR: ${e.message}`;
    } finally {
        document.body.classList.add("done");
    }
}

// ?matrix=<base64 JSON of {name, algorithms}[]>: each case alone, the results
// as JSON in the body (test/net/ssh-algorithms.ts)
async function runMatrix(
    cases: {
        name: string;
        algorithms: Record<string, string[]>;
        lines?: number;
    }[]
) {
    const results: Record<string, string> = {};
    for (const c of cases) {
        try {
            const out = await connect(c.algorithms, c.lines);
            results[c.name] = matrixOutputOk(out.stdout, c.lines)
                ? "ok"
                : `unexpected output: ${out.stdout.slice(0, 200)}`;
        } catch (e: any) {
            results[c.name] = e?.message ?? String(e);
        }
    }
    document.body.innerText = JSON.stringify(results);
    document.body.classList.add("done");
}

// ?features=<base64 JSON of the keys of test/net/ssh-algorithms.ts
// prepareKeys>: what packages use ssh2 for, beyond the handshake: key
// authentication, exec, shell, SFTP streams and port forwarding. Each
// case alone, its result "ok" or the error, as JSON in the body.
type SshKey = { key: string; passphrase?: string };

function connectWith(options: Record<string, unknown> = {}) {
    const ssh = new NodeSSH();
    return ssh
        .connect({
            host: "127.0.0.1",
            port,
            username: "testuser",
            readyTimeout: 30000,
            ...(options.privateKey ? {} : { password: "testpass" }),
            ...options
        })
        .then(() => ssh);
}

function expect(what: string, actual: unknown, expected: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `${what}: ${JSON.stringify(actual)} instead of ${JSON.stringify(expected)}`
        );
    }
}

const sftpCall = <T>(start: (cb: (e: Error, v?: T) => void) => void) =>
    new Promise<T>((resolve, reject) =>
        start((e, v) => (e ? reject(e) : resolve(v)))
    );

function features(keys: Record<string, SshKey>) {
    const cases: Record<string, (ssh: NodeSSH) => Promise<void>> = {
        "exec stdin, stderr and exit code": async (ssh) => {
            const result = await ssh.execCommand("cat; echo err >&2; exit 3", {
                stdin: "piped"
            });
            expect("stdout", result.stdout, "piped");
            expect("stderr", result.stderr, "err");
            expect("code", result.code, 3);
        },
        "exec channels in parallel": async (ssh) => {
            const results = await Promise.all(
                [1, 2, 3, 4].map((n) => ssh.execCommand(`echo ${n}`))
            );
            expect(
                "stdout",
                results.map((r) => r.stdout),
                ["1", "2", "3", "4"]
            );
        },
        shell: async (ssh) => {
            const shell = await ssh.requestShell();
            let output = "";
            await new Promise<void>((resolve, reject) => {
                shell.on("data", (d: Buffer) => (output += d.toString()));
                shell.on("close", resolve);
                shell.on("error", reject);
                shell.end("echo shell-$((40 + 2))\nexit\n");
            });
            if (!output.includes("shell-42")) {
                throw new Error(`shell output: ${output.slice(-200)}`);
            }
        },
        "sftp streams and directory": async (ssh) => {
            const sftp = await ssh.requestSFTP();
            const dir = `sftp-${Date.now()}`;
            const data = crypto.randomBytes(300000);
            await sftpCall((cb) => sftp.mkdir(dir, cb));
            await new Promise<void>((resolve, reject) => {
                const out = sftp.createWriteStream(`${dir}/a.bin`);
                out.on("close", resolve);
                out.on("error", reject);
                out.end(data);
            });
            const stats: any = await sftpCall((cb) =>
                sftp.stat(`${dir}/a.bin`, cb)
            );
            expect("size", stats.size, data.length);
            expect("isFile", stats.isFile(), true);
            await sftpCall((cb) =>
                sftp.rename(`${dir}/a.bin`, `${dir}/b.bin`, cb)
            );
            const list: any[] = await sftpCall((cb) => sftp.readdir(dir, cb));
            expect(
                "readdir",
                list.map((f) => f.filename),
                ["b.bin"]
            );
            const chunks: Buffer[] = [];
            await new Promise<void>((resolve, reject) => {
                const input = sftp.createReadStream(`${dir}/b.bin`);
                input.on("data", (c: Buffer) => chunks.push(c));
                input.on("end", resolve);
                input.on("error", reject);
            });
            const read = Buffer.concat(chunks);
            expect("read back", read.equals(data), true);
            await sftpCall((cb) =>
                sftp.writeFile(`${dir}/c.txt`, "hello sftp", cb)
            );
            const text: Buffer = await sftpCall((cb) =>
                sftp.readFile(`${dir}/c.txt`, cb)
            );
            expect("readFile", text.toString(), "hello sftp");
            const missing = await sftpCall((cb) =>
                sftp.stat(`${dir}/missing`, cb)
            ).then(
                () => "found",
                (e: any) => e.code
            );
            expect("stat of a missing file", missing, 2);
            await sftpCall((cb) => sftp.unlink(`${dir}/b.bin`, cb));
            await sftpCall((cb) => sftp.unlink(`${dir}/c.txt`, cb));
            await sftpCall((cb) => sftp.rmdir(dir, cb));
            sftp.end();
        },
        forwardOut: async (ssh) => {
            const greeting = await new Promise<string>((resolve, reject) => {
                ssh.connection.forwardOut(
                    "127.0.0.1",
                    0,
                    "127.0.0.1",
                    2222,
                    (e: Error, channel: any) => {
                        if (e) return reject(e);
                        channel.once("data", (d: Buffer) => {
                            resolve(d.toString());
                            channel.close();
                        });
                        channel.on("error", reject);
                    }
                );
            });
            if (!greeting.startsWith("SSH-")) {
                throw new Error(`greeting: ${greeting}`);
            }
        }
    };
    for (const [name, { key, passphrase }] of Object.entries(keys)) {
        cases[`key ${name}`] = async () => {
            const ssh = await connectWith({ privateKey: key, passphrase });
            try {
                const result = await ssh.execCommand("whoami");
                expect("whoami", result.stdout.trim(), "testuser");
            } finally {
                ssh.dispose();
            }
        };
    }
    return cases;
}

async function runFeatures(keys: Record<string, SshKey>) {
    const results: Record<string, string> = {};
    let ssh: NodeSSH;
    try {
        ssh = await connectWith();
    } catch (e: any) {
        results.connect = e?.message ?? String(e);
    }
    if (ssh) {
        for (const [name, run] of Object.entries(features(keys))) {
            try {
                await run(ssh);
                results[name] = "ok";
            } catch (e: any) {
                results[name] = e?.message ?? String(e);
            }
        }
        ssh.dispose();
    }
    document.body.innerText = JSON.stringify(results);
    document.body.classList.add("done");
}

const matrix = params.get("matrix");
const featureKeys = params.get("features");
if (matrix) {
    runMatrix(JSON.parse(atob(matrix)));
} else if (featureKeys) {
    runFeatures(JSON.parse(atob(featureKeys)));
} else {
    run();
}
