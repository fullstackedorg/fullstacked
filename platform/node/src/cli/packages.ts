import packagesLib from "../../../../core/internal/bundle/lib/packages/index.ts";
import { parseArgs, getDirectory } from "./utils.ts";

export async function executePackages(args: string[]) {
    const command = args[0];
    const { flags, positionals } = parseArgs(args.slice(1));
    const directory = getDirectory(flags);

    switch (command) {
        case "install":
            // install [-D/--save-dev] [packages...]
            const saveDev = !!(flags["D"] || flags["save-dev"]);

            // packagesLib.install returns a Promise that resolves to an EventEmitter.
            // We probably want to listen to events or something, but the lib signature says:
            // Promise<EventEmitter<{ "progress": Progress[] }>>

            const emitter = await packagesLib.install(
                directory,
                saveDev,
                ...positionals
            );

            // Listen to progress?
            emitter.on("progress", (progress) => {
                // Format progress?
                console.log(JSON.stringify(progress));
            });

            await emitter.duplex.promise();
            break;
        case "uninstall":
            // uninstall [packages...]
            const uninstallEmitter = await packagesLib.uninstall(
                directory,
                ...positionals
            );
            uninstallEmitter.on("progress", (progress) => {
                console.log(JSON.stringify(progress));
            });
            await uninstallEmitter.duplex.promise();
            break;
        case "audit":
            // audit
            const securityAudit = await packagesLib.audit(directory);
            console.log(securityAudit);
            break;
        default:
            console.log(`Unknown packages command: ${command}`);
    }
}
