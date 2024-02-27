import { FileTree } from "../file-tree";
import "./index.css";

import type { Project } from "../../../api/projects/types";
import type typeRPC from "../../../../src/webview";
import type api from "../../../api";

declare var rpc: typeof typeRPC<typeof api>;

export class ProjectNew {
    didCreateProjectAction: (newProject: Project) => void;
    cancelAction: () => void;

    async render() {
        const container = document.createElement("div");
        container.classList.add("project-new");

        // title
        const titleInputLabel = document.createElement("label");
        titleInputLabel.innerText = "Project Title";
        container.append(titleInputLabel);

        const titleInput = document.createElement("input");
        container.append(titleInput);

        // location
        const locationLabel = document.createElement("label");
        locationLabel.innerText = "Location";
        container.append(locationLabel);

        const fileTree = new FileTree();
        fileTree.directoryOnly = true;
        container.append(await fileTree.render());

        // buttons
        const buttonContainer = document.createElement("div");

        const cancelButton = document.createElement("button");
        cancelButton.classList.add("text");
        cancelButton.innerText = "Cancel";
        cancelButton.addEventListener("click", this.cancelAction);
        buttonContainer.append(cancelButton);

        const importer = document.createElement("div");

        const inputFile = document.createElement("input");
        inputFile.type = "file";
        inputFile.multiple = false;
        inputFile.accept = ".zip";
        importer.append(inputFile);
        inputFile.addEventListener("click", (e) => e.stopPropagation());
        inputFile.addEventListener("change", async () => {
            if (!inputFile.files?.[0]) return;

            const zipFile = inputFile.files[0];
            const title = zipFile.name.slice(0, -".zip".length);

            const projectBaseDirectory = fileTree.itemSelected
                ? fileTree.itemSelected.isDirectory
                    ? fileTree.itemSelected.path
                    : fileTree.itemSelected.path.slice(0, -1)
                : [];

            const location = [...projectBaseDirectory, title].join("/");
            const project = {
                location,
                title,
            };

            const importedProject = await rpc().projects.import(
                project,
                Array.from(new Uint8Array(await zipFile.arrayBuffer())),
            );
            this.didCreateProjectAction(importedProject);
        });

        const importButton = document.createElement("button");
        importButton.classList.add("secondary");
        importButton.innerText = "Import";
        importButton.addEventListener("click", (e) => {
            e.stopPropagation();
            inputFile.click();
        });
        importer.append(importButton);

        buttonContainer.append(importer);

        const createButton = document.createElement("button");
        createButton.innerText = "Create";
        createButton.addEventListener("click", async () => {
            const projectBaseDirectory = fileTree.itemSelected
                ? fileTree.itemSelected.isDirectory
                    ? fileTree.itemSelected.path
                    : fileTree.itemSelected.path.slice(0, -1)
                : [];

            const location = [...projectBaseDirectory, titleInput.value].join(
                "/",
            );

            const project = await rpc().projects.create({
                title: titleInput.value,
                location,
            });
            this.didCreateProjectAction(project);
        });
        buttonContainer.append(createButton);

        container.append(buttonContainer);

        return container;
    }
}
