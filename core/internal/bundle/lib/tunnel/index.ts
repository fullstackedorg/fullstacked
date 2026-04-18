import { bridge } from "../bridge/index.ts";
import { Tunnel as TunnelMod } from "../@types/index.ts";
import { Register, Tunnel } from "../@types/tunnel.ts";

export function register(tunnel: Tunnel): Promise<string> {
    return bridge({
        mod: TunnelMod,
        fn: Register,
        data: [tunnel]
    });
}

const tunnel = {
    register
};

export default tunnel;
