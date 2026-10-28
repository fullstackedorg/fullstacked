# git

```ts
import git from "fullstacked/git";
```

Git in the core, built on [go-git](https://github.com/go-git/go-git) v6. No `git` binary is needed. Every `directory` is a path in the project, resolved like an [`fs` path](../node/system.md#the-project-sandbox). Remotes are HTTP(S). Credentials come from a [`git-auth` plugin](#authentication).

Functions marked _stream_ return a [Duplex](index.md#streams-and-event-emitters) of progress text (the lines `git` prints on stderr) that must be consumed for the operation to run:

```ts
const progress = await git.clone(
    "https://github.com/fullstackedorg/demo.git",
    "/demo"
);
progress.on("data", (chunk) => console.log(new TextDecoder().decode(chunk)));
progress.on("close", () => console.log("cloned"));
progress.on("error", (e) => console.error(e));
```

## Repository

| Function                           | Returns            | Notes                                                                                                              |
| ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `hasGit(directory)`                | `Promise<boolean>` | Whether `directory` is a repository                                                                                |
| `init(directory, url)`             | `Promise<void>`    | `git init` with default branch `main`, and `origin` set to `url`                                                   |
| `setConfig(directory, key, value)` | `Promise<void>`    | Writes `.git/config`. `key` is `section.option` or `section.subsection.option` (`user.name`, `remote.origin.url`). |

## Working tree

| Function                             | Returns                | Notes                                                             |
| ------------------------------------ | ---------------------- | ----------------------------------------------------------------- |
| `status(directory)`                  | `Promise<GitStatus>`   | See below                                                         |
| `add(directory, path)`               | `Promise<void>`        | `"."` adds everything                                             |
| `restore(directory, ...files)`       | `Promise<void>`        | Restores the index and the working tree for `files`               |
| `reset(directory, hard, ...files)`   | `Promise<void>`        | Mixed, or hard when `hard` is `true`, optionally for `files` only |
| `commit(directory, message, author)` | `Promise<string>`      | The new commit's hash. `author` is `{ name, email }`.             |
| `head(directory)`                    | `Promise<GitHead>`     | `{ branch, hash, type }`                                          |
| `log(directory)`                     | `Promise<GitCommit[]>` | The **last 10** commits from HEAD                                 |

```ts
type GitStatus = {
    head: GitHead;
    staged: { [change: string]: string[] }; // e.g. { modified: ["a.ts"], added: ["b.ts"] }
    unstaged: { [change: string]: string[] };
    untracked: string[];
};
// change: "added" | "deleted" | "modified" | "copied" | "renamed" | "unmodified" | "untracked" | "unmerged" | "unknown"

type GitCommit = {
    hash: string;
    author: { name: string; email: string };
    date: string; // "Mon Jan 2 15:04:05 2006 -0700"
    message: string;
};
```

## Remotes

| Function                                     | Returns                | Notes                                                                                                                                                                                                        |
| -------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clone(url, directory, opts?)`               | _stream_               | If `directory` exists, clones into `directory/<repo name>`. Empty repositories are allowed. A failed clone removes the directory.                                                                            |
| `pull(directory, tunnel?)`                   | _stream_               | Pulls the current branch from `origin`. "Already up to date" isn't an error.                                                                                                                                 |
| `fetch(directory, tunnel?)`                  | _stream_               | Updates every remote-tracking branch and tag. The working tree is left alone.                                                                                                                                |
| `push(directory, tunnel?)`                   | _stream_               | Pushes to `origin`                                                                                                                                                                                           |
| `checkout(directory, ref, create?, tunnel?)` | _stream_               | `ref` is a branch, tag or commit. A branch or tag that exists only on the remote is fetched first. `create: true` makes a new branch. An unknown ref fails with `cannot find branch, tag or commit "<ref>"`. |
| `merge(directory, branch)`                   | `Promise<void>`        | go-git's merge (fast-forward), then a hard reset of the working tree to the result                                                                                                                           |
| `branch(directory)`                          | `Promise<GitBranch[]>` | `{ name, remote, local }[]`, local branches merged with `origin`'s (**needs the network**)                                                                                                                   |
| `tags(directory)`                            | `Promise<GitTag[]>`    | `{ name, hash, remote, local }[]`, also from `origin` (**needs the network**)                                                                                                                                |

`clone`'s `opts` is `{ tunnel?: string; proxy?: { url: string; headers: Record<string, string> } }`. For backward compatibility, a plain string is taken as the tunnel name.

- **`tunnel`**: the name of a registered [tunnel](tunnel.md). The git HTTP traffic goes through it.
- **`proxy`**: a reverse proxy URL and extra headers. They are saved in the clone's `.git/config` (`http.proxy`, `http.extraHeader`), so later pulls and pushes use them too.

Before a clone, pull, push or fetch, the core sends a `HEAD` request to the remote's host, so an unreachable host fails fast with a clear error.

## Authentication

The core asks for credentials only when a remote answers that authentication is required. It calls the context's **`git-auth` plugin** with the host and expects `{ username, password }` (a token goes in `password`), then retries once. Credentials are cached per host for the context's lifetime and dropped if they fail.

```ts
import plugin from "fullstacked/plugin";

await plugin.register("git-auth", {
    callback: async (host) => {
        if (host === "github.com")
            return {
                username: "x-access-token",
                password: process.env.GITHUB_TOKEN
            };
        return {};
    }
});
```

A context can have one `git-auth` plugin. With none, an authenticated remote fails with `no git auth plugins`. The FullStacked app's shell registers one that prompts in the terminal and stores credentials in `/user_data/`.

## Removed

`createGitAuthManager()` was replaced by the `git-auth` plugin. Calling it only logs a warning.
