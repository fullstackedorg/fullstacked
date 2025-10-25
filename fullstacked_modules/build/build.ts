import { Project } from "../../editor/types";
import { bridge } from "../bridge";
import {
    getLowestKeyIdAvailable,
    serializeArgs
} from "../bridge/serialization";
import type { Message } from "esbuild";
import core_message from "../core_message";
import { buildSASS } from "./sass";
import fs from "../fs";

core_message.addListener("build-style", async (messageStr) => {
    const { id, entryPoint, projectId } = JSON.parse(messageStr);
    const result = await buildSASS(entryPoint, {
        canonicalize: (filePath) => new URL(filePath, "file://"),
        load: (url) => fs.readFile(projectId + url.pathname, { encoding: "utf8" })
    })
    bridge(new Uint8Array([58, ...serializeArgs([id, JSON.stringify(result)])]))
});

const activeBuilds = new Map<
    number,
    { project: Project; resolve: (buildErrors: Message[]) => void }
>();

function buildResponse(buildResult: string) {
    const { id, errors } = JSON.parse(buildResult);
    const activeBuild = activeBuilds.get(id);

    if (!errors) {
        activeBuild.resolve([]);
    } else {
        const messages = errors.map(uncapitalizeKeys).map((error) => ({
            ...error,
            location: error.location
                ? {
                    ...error.location,
                    file: error.location.file.includes(activeBuild.project.id)
                        ? activeBuild.project.id +
                        error.location.file
                            .split(activeBuild.project.id)
                            .pop()
                        : error.location.file
                }
                : null
        }));
        activeBuild.resolve(messages);
    }

    activeBuilds.delete(id);
}
core_message.addListener("build", buildResponse);

// 55
export function esbuildVersion(): Promise<string> {
    const payload = new Uint8Array([55]);
    return bridge(payload, ([str]) => str);
}

// 56
export function buildProject(project?: Project): Promise<Message[]> {
    const args: any[] = project ? [project.id] : [];

    const buildId = getLowestKeyIdAvailable(activeBuilds);
    args.push(buildId);

    const payload = new Uint8Array([56, ...serializeArgs(args)]);
    
    return new Promise((resolve) => {
        activeBuilds.set(buildId, {
            project,
            resolve
        });
        bridge(payload);
    });
}

// 57
export function shouldBuild(project: Project): Promise<boolean> {
    const payload = new Uint8Array([57, ...serializeArgs([project.id])]);

    return bridge(payload, ([should]) => should);
}

function isPlainObject(input: any) {
    return input && !Array.isArray(input) && typeof input === "object";
}

function uncapitalizeKeys<T>(obj: T) {
    const final = {};
    for (const [key, value] of Object.entries(obj)) {
        final[key.at(0).toLowerCase() + key.slice(1)] = isPlainObject(value)
            ? uncapitalizeKeys(value)
            : value;
    }
    return final as T;
}
