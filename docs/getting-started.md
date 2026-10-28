# Getting started

## Install

**The app**, on any device:

- [Apple App Store](https://apps.apple.com/ca/app/fullstacked/id6477835950): macOS, iOS, iPadOS
- [Google Play](https://play.google.com/store/apps/details?id=org.fullstacked.editor): Android, ChromeOS
- [Microsoft Store](https://apps.microsoft.com/detail/9p987qm508vc): Windows 10 and 11
- Beta builds and Linux: [fullstacked.org/download](https://fullstacked.org/download)

The app opens on the **shell**, a terminal where your projects live. Its commands include `git`, `npm`, `bundle`, `run`, `fullstacked`, `ls`, `cd`, `vi`, `ssh`, `curl` and `config`. Run `help` for the full list.

**The CLI**, on a desktop with Node.js:

```bash
npm install -g fullstacked
```

## A first project

In the shell or a terminal:

```bash
mkdir hello
```

```bash
cd hello
```

Create `index.ts`:

```ts
import fs from "node:fs";
import os from "node:os";

// Node's APIs...
fs.writeFileSync(
    "/visits.txt",
    String(
        Number(
            fs.existsSync("/visits.txt")
                ? fs.readFileSync("/visits.txt", "utf8")
                : 0
        ) + 1
    )
);
const visits = fs.readFileSync("/visits.txt", "utf8");

// ...and the DOM, in the same file
const h1 = document.createElement("h1");
h1.innerText = `Hello from ${os.platform()}, visit #${visits}`;
document.body.append(h1);
```

Run it:

```bash
fullstacked
```

The project is bundled into `out/` and opens in a window: a new window in the app, or your browser at `http://localhost:9000` with the CLI. `/visits.txt` is a file in the project directory, which is the [root of the project's sandbox](node/system.md#the-project-sandbox).

## With npm packages and React

```bash
npm install react react-dom
```

Add a `tsconfig.json` so JSX uses the automatic runtime:

```json
{ "compilerOptions": { "jsx": "react-jsx" } }
```

```tsx
// index.tsx
import { createRoot } from "react-dom/client";
import { useState } from "react";
import { readdir } from "node:fs/promises";

function App() {
    const [files, setFiles] = useState<string[]>([]);
    return (
        <>
            <button onClick={async () => setFiles(await readdir("/"))}>
                List files
            </button>
            <ul>
                {files.map((f) => (
                    <li key={f}>{f}</li>
                ))}
            </ul>
        </>
    );
}

const root = document.createElement("div");
document.body.append(root);
createRoot(root).render(<App />);
```

In the app's shell, `npm install` runs the core's installer, so no Node is needed on the device. On a desktop, plain npm works too.

## Clone and run an existing project

```bash
git clone https://github.com/<owner>/<repo>.git
```

```bash
cd <repo>
```

```bash
npm install
```

```bash
fullstacked
```

## Next

- [Project structure](project-structure.md): what goes where, static files, environment variables, workers.
- [Node.js compatibility](node/index.md): which built-ins work, and how.
- [Runtime API](api/index.md): bundling, git, packages and more from your own code.
