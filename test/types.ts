import child_process from "child_process";
import "../declarations";

// typecheck
child_process.execSync("npm run typecheck", {
    stdio: "inherit"
});

process.exit(0);
