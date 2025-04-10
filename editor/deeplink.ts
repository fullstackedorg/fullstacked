import { Button, Dialog } from "@fullstacked/ui";
import { createElement } from "./components/element";
import config from "./lib/config";
import { Store } from "./store";
import { CONFIG_TYPE, Project as ProjectType } from "./types";
import { CloneGit } from "./views/add-project/clone-git";
import { Project } from "./views/project";

// fullstacked://http//github.....git
export async function deeplink(fullstackedUrl: string) {
    console.log(fullstackedUrl);

    let url = fullstackedUrl.slice("fullstacked://".length);

    const [protocol, ...rest] = url.split("//");
    const [hostAndPath] = rest.join("//").split("?");
    url = protocol + (protocol.endsWith(":") ? "" : ":") + "//" + hostAndPath;

    if(!url.endsWith(".git")) {
        url += ".git";
    }

    const runProjectIfFound = (projects: ProjectType[]) => {
        console.log(projects, url);
        const existingProject = projects?.find(
            (p) => p.gitRepository?.url === url
        );
        if (existingProject) {
            Store.projects.list.unsubscribe(runProjectIfFound);

            let isUserMode = Store.preferences.isUserMode.check();
            if (!isUserMode) {
                Project(existingProject);
            }

            Store.projects.build(existingProject);
            return true;
        }

        return false;
    };

    const { projects } = await config.get(CONFIG_TYPE.PROJECTS);

    if (runProjectIfFound(projects)) return;

    Store.projects.list.subscribe(runProjectIfFound);
    CloneGit(url);
}

export function WindowsAskForAdmin() {
    const container = createElement("div");
    container.classList.add("win-admin-dialog");
    container.innerHTML = `
        <h1>Welcome,</h1>
        <p>Please close FullStacked and reopen it with <b>Run as administrator</b>.<p>
        <p>It will register the FullStacked deeplink and enable the <b>Open in FullStacked</b> feature in your system.</p>
        <p>You can open FullStacked normally afterwards.</p>
        <p>You only have to do this operation <b>once</b>.</p>
    `;
    const closeButton = Button({
        text: "Close"
    });
    container.append(closeButton);
    const { remove } = Dialog(container);
    closeButton.onclick = () => {
        remove();
        fetch("/restart-admin");
    };
}
