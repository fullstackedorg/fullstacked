import { Tunnel as TunnelMod } from "../@types/index.ts";
import { Register, type Tunnel } from "../@types/tunnel.ts";

export function register(tunnel: Tunnel): Promise<string> {
    return globalThis.fullstacked.bridge({
        mod: TunnelMod,
        fn: Register,
        data: [tunnel]
    });
}

const tunnel = {
    register
};

export default tunnel;
