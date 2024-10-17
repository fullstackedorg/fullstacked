import rpc from "../../rpc";
import git from "../git";
import projects from "../projects";
import { Project, GitAuths, Connectivity } from "../config/types";
import { CONFIG_TYPE } from "./types";

type DATA_TYPE = {
    [CONFIG_TYPE.PROJECTS]: Project[];
    [CONFIG_TYPE.GIT]: GitAuths;
    [CONFIG_TYPE.CONNECTIVITY]: Connectivity;
};

const configCacheDelay = 2000;
const configCache: Partial<{
    [K in keyof DATA_TYPE]: {
        promise: Promise<DATA_TYPE[K]>;
        timeout?: ReturnType<typeof setTimeout>;
    };
}> = {};

export default {
    async init() {
        const configDir = await rpc().directories.configDirectory();
        if (await rpc().fs.exists(configDir, { absolutePath: true })) return;

        await rpc().fs.mkdir(configDir, { absolutePath: true });
        const project = await projects.import(
            {
                title: "Demo",
                id: "org.fullstacked.demo",
                location: "fullstackedorg/editor-sample-demo",
                gitRepository: {
                    url: "https://github.com/fullstackedorg/editor-sample-demo.git"
                }
            },
            (await rpc().fs.readFile("Demo.zip")) as Uint8Array
        );
        await git.init(project);
    },
    load<T extends keyof DATA_TYPE>(type: T): Promise<DATA_TYPE[T]> {
        if (!configCache[type]) {
            const promise = new Promise<DATA_TYPE[T]>(async (resolve) => {
                const configDir = await rpc().directories.configDirectory();
                const configFile = configDir + "/" + type + ".json";

                const configFileExists = (
                    await rpc().fs.exists(configFile, { absolutePath: true })
                )?.isFile;
                if (!configFileExists) {
                    return resolve(null);
                }

                const contents = (await rpc().fs.readFile(configFile, {
                    encoding: "utf8",
                    absolutePath: true
                })) as string;

                resolve(JSON.parse(contents));

                configCache[type].timeout = setTimeout(() => {
                    delete configCache[type];
                }, configCacheDelay);
            });

            configCache[type] = {
                promise
            } as (typeof configCache)[T];
        }

        return configCache[type].promise;
    },
    async save<T extends CONFIG_TYPE>(type: T, data: DATA_TYPE[T]) {
        const configDir = await rpc().directories.configDirectory();
        const configFile = configDir + "/" + type + ".json";
        delete configCache[type];
        rpc().fs.writeFile(configFile, JSON.stringify(data, null, 2), {
            absolutePath: true
        });
    }
};
