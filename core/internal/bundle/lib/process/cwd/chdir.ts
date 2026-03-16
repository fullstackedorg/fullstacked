import path from "../../path/index.ts";
import { cwd, setDir } from "./index.ts";

export function chdir(dir: string) {
    if (dir.startsWith(path.sep)) {
        setDir(dir);
    } else {
        setDir(path.resolve(cwd(), dir));
    }
}
