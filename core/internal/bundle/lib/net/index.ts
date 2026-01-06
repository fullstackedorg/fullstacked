// nodejs source: https://nodejs.org/docs/latest/api/net.html

import { bridge } from "../bridge/index.ts";
import { Net } from "../@types/index.ts";
import { Connect } from "../@types/net.ts";
import { Duplex } from "../bridge/duplex.ts";
import EventEmitter from "events";


export class Socket extends EventEmitter {
    private duplex: Duplex = null;

    connect(port: number, host?: string) {
        const h = host || "localhost";
        bridge({
            mod: Net,
            fn: Connect,
            data: [port, h]
        }).then(d => {
            this.duplex = d;
            this.duplex.on("data", (data: Uint8Array) => this.emit("data", data));
            this.duplex.on("close", () => this.emit("close"));
            this.emit("connect");
        });
    }

    destroy(){
        this.duplex.end();
    }

    write(data: Uint8Array){
        this.duplex.write(data);
    }
}

export function connect(port: number, host?: string) {
    const socket = new Socket();
    socket.connect(port, host);
    return socket;
} 

export default {
    Socket,
    connect
}