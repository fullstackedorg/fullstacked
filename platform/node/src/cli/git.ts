import gitLib from "../../../../core/internal/bundle/lib/git/index.ts";
import { parseArgs, getDirectory, runDuplex } from "./utils.ts";

export async function executeGit(args: string[]) {
    const command = args[0];
    const { flags, positionals } = parseArgs(args.slice(1));
    const directory = getDirectory(flags);

    switch (command) {
        case "init":
            if (positionals.length < 1) throw new Error("Usage: git init <url>");
            console.log(gitLib.init(directory, positionals[0]));
            break;
        case "status":
            console.log(gitLib.status(directory));
            break;
        case "add":
            if (positionals.length < 1) throw new Error("Usage: git add <path>");
            console.log(gitLib.add(directory, positionals[0]));
            break;
        case "log":
            console.log(gitLib.log(directory));
            break;
        case "clone":
            if (positionals.length < 1) throw new Error("Usage: git clone <url>");
            await runDuplex(gitLib.clone(positionals[0], directory));
            break;
        case "commit":
            const message = flags["m"] as string || flags["message"] as string;
            const authorName = flags["name"] as string;
            const authorEmail = flags["email"] as string;
            if (!message) throw new Error("Usage: git commit -m <message>");

            const author = {
                name: authorName || "FullStacked User",
                email: authorEmail || "user@fullstacked.org"
            };

            console.log(gitLib.commit(directory, message, author));
            break;
        case "pull":
            await runDuplex(gitLib.pull(directory));
            break;
        case "push":
            await runDuplex(gitLib.push(directory));
            break;
        case "reset":
            console.log(gitLib.reset(directory, ...positionals));
            break;
        case "branch":
            console.log(gitLib.branch(directory));
            break;
        case "tags":
            console.log(gitLib.tags(directory));
            break;
        case "checkout":
            if (positionals.length < 1) throw new Error("Usage: git checkout <ref>");
            const create = !!(flags["b"] || flags["create"] || flags["B"]);
            await runDuplex(gitLib.checkout(directory, positionals[0], create));
            break;
        case "merge":
            if (positionals.length < 1) throw new Error("Usage: git merge <branch>");
            console.log(await gitLib.merge(directory, positionals[0]));
            break;
        default:
            console.log(`Unknown git command: ${command}`);
    }
}
