export function parseArgs(args: string[]) {
    const flags: Record<string, string | boolean> = {};
    const positionals: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("--")) {
            const key = arg.slice(2);
            if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
                flags[key] = args[i + 1];
                i++;
            } else {
                flags[key] = true;
            }
        } else if (arg.startsWith("-")) {
            // Handle short flags if needed, simple mapping for now
            const key = arg.slice(1);
            if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
                flags[key] = args[i + 1];
                i++;
            } else {
                flags[key] = true;
            }
        } else {
            positionals.push(arg);
        }
    }
    return { flags, positionals };
}

export function getDirectory(flags: Record<string, string | boolean>) {
    return (flags["directory"] as string) || process.cwd();
}

export async function runDuplex(duplexPromise: any) {
    const duplex = await duplexPromise;
    if (duplex && duplex[Symbol.asyncIterator]) {
        for await (const chunk of duplex) {
            process.stdout.write(chunk);
        }
    } else {
        console.log(duplex);
    }
}
