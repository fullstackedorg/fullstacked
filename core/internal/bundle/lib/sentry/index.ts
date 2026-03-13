import { Sentry } from "../@types/index.ts";
import { Init } from "../@types/sentry.ts";
import { bridge } from "../bridge/index.ts";
import os from "../os/index.ts";

export function init(dsn: string, release: string) {
    bridge({
        mod: Sentry,
        fn: Init,
        data: [dsn, release, `${os.platform()}-${os.arch()}`]
    });
}

const sentry = {
    init
}

export default sentry;
