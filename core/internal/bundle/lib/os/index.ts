// nodejs source: https://nodejs.org/api/os.html

import { Os } from "../@types/index.ts";
import {
    Arch,
    Endieness,
    Hostname,
    Platform,
    Uname,
    UnameInfo
} from "../@types/os.ts";
import fs from "../fs/index.ts";

const cache = {
    platform: null,
    arch: null,
    endianness: null,
    uname: null as UnameInfo,
    hostname: null
};

export function platform(): string {
    if (cache.platform === null) {
        cache.platform = globalThis.fullstacked.bridge(
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
        cache.arch = globalThis.fullstacked.bridge(
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
        cache.endianness = globalThis.fullstacked.bridge(
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
        cache.uname = globalThis.fullstacked.bridge(
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

export function hostname(): string {
    if (cache.hostname === null) {
        cache.hostname = globalThis.fullstacked.bridge(
            {
                mod: Os,
                fn: Hostname
            },
            true
        );
    }
    return cache.hostname;
}

const tmpDirectory = "/.tmp";
export function tmpdir(): string {
    if (!fs.existsSync(tmpDirectory)) {
        fs.mkdirSync(tmpDirectory);
    }
    return tmpDirectory;
}

export default {
    platform,
    arch,
    endianness,
    release,
    type,
    hostname,
    tmpdir
};

