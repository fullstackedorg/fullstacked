import { Project } from "../../editor/types";
import { bridge } from "../bridge";
import {
    getLowestKeyIdAvailable,
    serializeArgs
} from "../bridge/serialization";
import core_message from "../core_message";

const activeInstallations = new Map<
    number,
    {
        project: Project;
        installing: Map<string, PackageInfoProgress>;
        progress?: InstallationProgressCb;
        resolve: (result: InstallationResult) => void;
    }
>();

type InstallationResult = {
    duration: number;
    packagesInstalledCount: number;
};

export type PackageInfoProgress = {
    stage: string;
    loaded: number;
    total: number;
};

export type PackageInfo = {
    name: string;
    version: string;
    direct: boolean;
    dependencies: PackageInfo[];
    progress: PackageInfoProgress;
};

type InstallationProgressCb = (
    packages: [string, PackageInfoProgress][]
) => void;

function installationsListener(messageStr: string) {
    const message = JSON.parse(messageStr) as { id: number };

    const activeInstallation = activeInstallations.get(message.id);

    if (!activeInstallation) {
        console.log(
            "received packages installation notification for unknown active installation"
        );
        return;
    }

    if (typeof message["duration"] === "undefined") {
        const { name, version, progress } = message as {
            id: number;
        } & PackageInfo;

        const packageName = name + "@" + version;

        if (progress.stage === "done") {
            activeInstallation.installing.delete(packageName);
        } else {
            activeInstallation.installing.set(packageName, progress);
        }

        const arr = Array.from(activeInstallation.installing).sort((a, b) =>
            a[0] < b[0] ? -1 : 1
        );

        activeInstallation.progress?.(arr);
        return;
    }

    const installation = message as {
        id: number;
    } & InstallationResult;

    activeInstallation.resolve(installation);
    activeInstallations.delete(message.id);
}

let addedListener = false;
function setListenerOnce() {
    if (addedListener) return;

    core_message.addListener("packages-installation", installationsListener);

    addedListener = true;
}

// 60
export function install(
    project: Project,
    packagesNames: string[],
    progress?: InstallationProgressCb,
    dev = false
) {
    setListenerOnce();

    const installationId = getLowestKeyIdAvailable(activeInstallations);

    let args: any[] = [project.id, installationId, dev, ...packagesNames];

    const payload = new Uint8Array([60, ...serializeArgs(args)]);

    return new Promise<InstallationResult>((resolve) => {
        activeInstallations.set(installationId, {
            project,
            progress,
            resolve,
            installing: new Map()
        });

        bridge(payload);
    });
}

//61
export function installQuick(
    project?: Project,
    progress?: InstallationProgressCb
) {
    setListenerOnce();

    const installationId = getLowestKeyIdAvailable(activeInstallations);

    let args: any[] = project ? [project.id, installationId] : [installationId];

    const payload = new Uint8Array([61, ...serializeArgs(args)]);

    return new Promise<InstallationResult>((resolve) => {
        activeInstallations.set(installationId, {
            project,
            progress,
            resolve,
            installing: new Map()
        });

        bridge(payload);
    });
}
