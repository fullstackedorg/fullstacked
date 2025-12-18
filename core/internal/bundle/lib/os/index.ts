// nodejs source: https://nodejs.org/api/os.html

import { bridge } from "../bridge/index.ts";
import { Os } from "../@types/index.ts";
import { Platform } from "../@types/os.ts";

export function platform(): string {
    return bridge(
        {
            mod: Os,
            fn: Platform
        },
        true
    );
}
