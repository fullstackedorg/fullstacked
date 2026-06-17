import { NodeSSH } from "node-ssh";

const params = new URLSearchParams(window.location.search);
const port = parseInt(params.get("port") || "2222", 10);

const ssh = new NodeSSH();

async function run() {
    try {
        await ssh.connect({
            host: "127.0.0.1",
            port: port,
            username: "testuser",
            password: "testpass",
            readyTimeout: 30000
        });

        const result = await ssh.execCommand("echo hello world");

        if (result.stdout.trim() === "hello world") {
            document.body.innerText = "SUCCESS";
        } else {
            document.body.innerText = `FAILED: ${result.stdout}`;
        }
    } catch (e: any) {
        document.body.innerText = `ERROR: ${e.message}`;
    } finally {
        ssh.dispose();
        document.body.classList.add("done");
    }
}

run();
