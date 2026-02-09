// nodejs source: https://nodejs.org/api/os.html

import { bridge } from "../bridge/index.ts";
import { Os } from "../@types/index.ts";
import { Arch, Endieness, Platform, Uname, UnameInfo } from "../@types/os.ts";

export function platform(): string {
    return bridge(
        {
            mod: Os,
            fn: Platform
        },
        true
    );
}

export function arch(): string {
    return bridge(
        {
            mod: Os,
            fn: Arch
        },
        true
    );
}

export function endianness(): string {
    return bridge(
        {
            mod: Os,
            fn: Endieness
        },
        true
    );
}

let cachedUname: UnameInfo = null;
function getUname() {
    if (!cachedUname) {
        cachedUname = bridge(
            {
                mod: Os,
                fn: Uname
            },
            true
        );
    }

    return cachedUname;
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
