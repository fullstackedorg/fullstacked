import { execSync } from "node:child_process";
import net from "node:net";
import { Worker } from "node:worker_threads";

export type ServerWorker = Worker & { port: number };

// Starts a test server on its own thread. The server listens on a port the
// system picks and posts it once bound: a fixed port could still be held by
// a stale run, which then answered this one, and a request sent before the
// bind was lost. Rejects when the server fails or exits before listening.
// An error after that is not caught here: it fails the run instead of
// leaving a test waiting for a server that is gone.
export function startWorkerServer(file: string, workerData?: unknown) {
    return new Promise<ServerWorker>((resolve, reject) => {
        const worker = new Worker(file, { workerData });
        const onExit = (code: number) =>
            reject(new Error(`${file} exited with ${code} before listening`));
        worker.once("error", reject);
        worker.once("exit", onExit);
        worker.once("message", (port: number) => {
            worker.off("error", reject);
            worker.off("exit", onExit);
            resolve(Object.assign(worker, { port }));
        });
    });
}

// a port free on this host: one the system just gave and took back
export async function freePort() {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

// Runs a container with containerPort published on 127.0.0.1, at a port
// free on this host, and resolves with that port. A port Docker picks is free
// only in Docker's own network namespace: rootless Docker then fails to bind
// it on the host when a test already holds it ("address already in use").
// A container created before the failure is removed.
export async function runContainer(
    name: string,
    args: string,
    containerPort: number
) {
    const port = await freePort();
    try {
        execSync(
            `docker run -d --name ${name} -p 127.0.0.1:${port}:${containerPort} ${args}`,
            { stdio: "pipe" }
        );
    } catch (e) {
        try {
            execSync(`docker rm -f ${name}`, { stdio: "ignore" });
        } catch {
            // never created
        }
        throw e;
    }
    return port;
}
