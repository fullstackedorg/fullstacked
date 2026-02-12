import path from "path";
import { cwd, setDir } from "./index.ts";

export function chdir(dir: string) {
    if (dir.startsWith("/")) {
        setDir(dir);
    } else {
        setDir(path.resolve(cwd(), dir));
    }
}
