import child_process from "node:child_process";

child_process.execSync("go run ./generate.go", {
    cwd: "types",
    stdio: "inherit"
});
