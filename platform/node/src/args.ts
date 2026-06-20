export function findArg(aliases: string[], args?: string[]): boolean;
export function findArg(
    aliases: string[],
    hasValue: true,
    args?: string[]
): string[];
export function findArg(
    aliases: string[],
    hasValueOrArgs?: boolean | string[],
    customArgs?: string[]
): boolean | string[] {
    const hasValue =
        typeof hasValueOrArgs === "boolean" ? hasValueOrArgs : false;
    const args = Array.isArray(hasValueOrArgs)
        ? hasValueOrArgs
        : customArgs || process.argv.slice(2);

    const values: string[] = [];
    let present = false;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (aliases.includes(arg)) {
            present = true;
            if (hasValue) {
                const next = args[i + 1];
                if (next !== undefined && !next.startsWith("-")) {
                    values.push(next);
                    i++;
                } else {
                    values.push("");
                }
            }
        } else if (hasValue) {
            for (const alias of aliases) {
                if (arg.startsWith(alias + "=")) {
                    values.push(arg.slice(alias.length + 1));
                    present = true;
                    break;
                }
            }
        }
    }

    return hasValue ? values : present;
}

export function getPositionalArgs(args = process.argv.slice(2)): string[] {
    const positional: string[] = [];
    const valueFlags = [
        ["-e", "--env"],
        ["-p", "--port"]
    ];
    const booleanFlags = [
        ["-h", "--help"],
        ["-v", "--version"],
        ["-o", "--open"],
        ["-b", "--build"]
    ];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (booleanFlags.some((aliases) => aliases.includes(arg))) {
            continue;
        }

        let isValueFlag = false;
        for (const aliases of valueFlags) {
            if (aliases.includes(arg)) {
                const next = args[i + 1];
                if (next !== undefined && !next.startsWith("-")) {
                    i++;
                }
                isValueFlag = true;
                break;
            }
            let matchedPrefix = false;
            for (const alias of aliases) {
                if (arg.startsWith(alias + "=")) {
                    matchedPrefix = true;
                    break;
                }
            }
            if (matchedPrefix) {
                isValueFlag = true;
                break;
            }
        }

        if (isValueFlag) {
            continue;
        }

        if (arg.startsWith("-")) {
            continue;
        }

        positional.push(arg);
    }

    return positional;
}
