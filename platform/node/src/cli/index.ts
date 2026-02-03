import { executeGit } from "./git.ts";
import { executePackages } from "./packages.ts";
import { executeBundle } from "./bundle.ts";
import type { Core } from "../core.ts";

export async function execute(args: string[], core: Core) {
    const command = args[0];

    switch (command) {
        case "git":
            await executeGit(args.slice(1));
            break;
        case "npm":
            await executePackages(args.slice(1));
            break;
        case "bundle":
            await executeBundle(args.slice(1));
            break;
        default:
            console.log(`Unknown command: ${command} `);
            console.log("Available commands: git, npm, bundle");
    }
}
