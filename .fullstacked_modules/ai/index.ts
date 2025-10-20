import * as aiAgent from "@fullstacked/ai-agent";
import { z as zod } from "zod";
export * from "./tools/fs";
import { createToolFS } from "./tools/fs";

export * from "@fullstacked/ai-agent";

export const z = zod;

export default {
    ...aiAgent,
    createToolFS,
    z: zod
};
