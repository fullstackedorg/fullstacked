// nodejs source: https://nodejs.org/api/os.html

import { bridge } from "../bridge/index.ts";
import { Os } from "../@types/index.ts";
import { Arch, Endieness, Platform, Uname, UnameInfo } from "../@types/os.ts";

const cache = {
    platform: null,
    arch: null,
    endianness: null,
    uname: null as UnameInfo
};

export function platform(): string {
    if (cache.platform === null) {
        cache.platform = bridge(
            {
                mod: Os,
                fn: Platform
            },
            true
        );
    }
    return cache.platform;
}

export function arch(): string {
    if (cache.arch === null) {
        cache.arch = bridge(
            {
                mod: Os,
                fn: Arch
            },
            true
        );
    }
    return cache.arch;
}

export function endianness(): string {
    if (cache.endianness === null) {
        cache.endianness = bridge(
            {
                mod: Os,
                fn: Endieness
            },
            true
        );
    }
    return cache.endianness;
}

function getUname() {
    if (cache.uname === null) {
        cache.uname = bridge(
            {
                mod: Os,
                fn: Uname
            },
            true
        );
    }

    return cache.uname;
}

export function release(): string {
    return getUname().release;
}

export function type(): string {
    return getUname().sysname;
}

export default {
    platform,
    arch,
    endianness,
    release
};
