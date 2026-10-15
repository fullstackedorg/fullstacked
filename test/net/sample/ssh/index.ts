import { NodeSSH } from "node-ssh";

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

const matrix = params.get("matrix");
if (matrix) {
    runMatrix(JSON.parse(atob(matrix)));
} else {
    run();
}
