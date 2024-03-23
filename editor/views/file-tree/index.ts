import "./index.css";
import { NEW_FILE_ID } from "../../constants";
import rpc from "../../rpc";
import type { Dirent } from "../../../src/adapter/fs";


export class FileTree {
    allowDeletion = false;
    directoryOnly = false;
    noNewItems = false;

    private ulRoot: HTMLUListElement;
    private baseDirectory: string[] = [];

    itemSelected:
        | {
              element: HTMLLIElement;
              path: string[];
              isDirectory: boolean;
          }
        | undefined;
    onItemSelect: (item: FileTree["itemSelected"]) => void;

    setBaseDirectory(path: string) {
        this.baseDirectory = path.split("/");
    }

    private async renderItemSpan(
        itemPath: string[],
        isDirectory: boolean,
        parentLi: HTMLLIElement,
        expanded = false
    ) {
        const span = document.createElement("span");
        span.innerText = `${
            isDirectory ? (expanded ? "▼ " : "▶ ") : ""
        }${itemPath.at(-1)}`;

        if (this.allowDeletion) {
            const deleteButton = document.createElement("button");
            deleteButton.classList.add("text", "small", "danger");
            deleteButton.innerHTML = await (
                await fetch("/assets/icons/delete.svg")
            ).text();
            deleteButton.addEventListener("click", async (e) => {
                e.stopPropagation();

                if (this.itemSelected?.element === parentLi) {
                    this.itemSelected = undefined;
                }

                const path = itemPath.join("/");
                if (isDirectory) await rpc().fs.rmdir(path, { absolutePath: true });
                else await rpc().fs.unlink(path, { absolutePath: true });

                parentLi.remove();
            });
            span.append(deleteButton);
        }

        return span;
    }

    private async openDirectory(pathComponents: string[]) {
        const ul = document.createElement("ul");

        let items = (await rpc().fs.readdir(pathComponents.join("/"), {
            withFileTypes: true,
            absolutePath: true
        })) as Dirent[];
        items = items.filter(({ name, isDirectory }) => {
            if (name.startsWith(".")) return false;

            if (this.directoryOnly) return isDirectory;

            return true;
        });

        for (const { name, isDirectory } of items) {
            const itemPathComponents = [...pathComponents, name];

            const li = document.createElement("li");
            li.append(
                await this.renderItemSpan(itemPathComponents, !!isDirectory, li)
            );

            li.addEventListener("click", async (e) => {
                e.stopPropagation();

                if (this.itemSelected) {
                    this.itemSelected.element.removeAttribute("aria-selected");
                    this.itemSelected.element.classList.remove("selected");
                }

                this.itemSelected = {
                    element: li,
                    path: itemPathComponents,
                    isDirectory: !!isDirectory
                };

                if (this.onItemSelect) this.onItemSelect(this.itemSelected);

                li.setAttribute("aria-selected", "true");
                li.classList.add("selected");

                if (isDirectory) {
                    Array.from(li.children).forEach((child) => child.remove());

                    const expand = !(
                        li.getAttribute("aria-expanded") === "true"
                    );
                    li.append(
                        await this.renderItemSpan(
                            itemPathComponents,
                            !!isDirectory,
                            li,
                            expand
                        )
                    );

                    if (expand) {
                        li.append(await this.openDirectory(itemPathComponents));
                    } else {
                        li.querySelector("ul")?.remove();
                    }

                    li.setAttribute("aria-expanded", expand.toString());
                }
            });

            ul.append(li);
        }

        return ul;
    }

    private createInputAtSelectedLocation() {
        let selectedUl = this.itemSelected
            ? this.itemSelected.isDirectory
                ? this.itemSelected.element.querySelector(":scope > ul")
                : this.itemSelected.element.parentElement
            : this.ulRoot;

        const newLi = document.createElement("li");
        const newNameInput = document.createElement("input");
        newNameInput.autocapitalize = "off";
        newLi.append(newNameInput);
        selectedUl?.append(newLi);

        return {
            ul: selectedUl,
            li: newLi,
            input: newNameInput
        };
    }

    private mkdir() {
        const { ul, li, input } = this.createInputAtSelectedLocation();

        li.prepend("▶ ");

        const mkDir = async () => {
            const newDirectoryName = input.value;

            li.remove();

            if (!newDirectoryName) return;

            const parentDirectoryPathComponents = this.itemSelected
                ? this.itemSelected.isDirectory
                    ? this.itemSelected.path
                    : this.itemSelected.path.slice(0, -1)
                : this.baseDirectory;

            await rpc().fs.mkdir(
                parentDirectoryPathComponents.join("/") + "/" + newDirectoryName,
                { absolutePath: true }
            );

            const updatedChildrenList = await this.openDirectory(
                parentDirectoryPathComponents
            );

            if (ul === this.ulRoot) {
                updatedChildrenList.classList.add("file-tree");
                this.ulRoot = updatedChildrenList;
            }

            ul?.replaceWith(updatedChildrenList);
        };

        input.addEventListener("keydown", async (e) => {
            const key = e.key;
            if (key !== "Enter") return;

            mkDir();
        });
        input.addEventListener("blur", () => {
            mkDir();
        });

        input.focus();
    }

    private touch() {
        const { ul, li, input } = this.createInputAtSelectedLocation();

        const touch = async () => {
            const newFileName = input.value;

            li.remove();

            if (!newFileName) return;

            const parentDirectoryPathComponents = this.itemSelected
                ? this.itemSelected.isDirectory
                    ? this.itemSelected.path
                    : this.itemSelected.path.slice(0, -1)
                : this.baseDirectory;

            await rpc().fs.writeFile(
                parentDirectoryPathComponents.join("/") + "/" + newFileName,
                "\n",
                { absolutePath: true }
            );

            const updatedChildrenList = await this.openDirectory(
                parentDirectoryPathComponents
            );

            if (ul === this.ulRoot) {
                updatedChildrenList.classList.add("file-tree");
                this.ulRoot = updatedChildrenList;
            }

            ul?.replaceWith(updatedChildrenList);
        };

        input.addEventListener("keydown", async (e) => {
            const key = e.key;
            if (key !== "Enter") return;

            touch();
        });
        input.addEventListener("blur", () => {
            touch();
        });

        input.focus();
    }

    private async addFile(file: File) {
        const parentDirectoryPathComponents = this.itemSelected
            ? this.itemSelected.isDirectory
                ? this.itemSelected.path
                : this.itemSelected.path.slice(0, -1)
            : this.baseDirectory;

        const filePath =
            parentDirectoryPathComponents.join("/") + "/" + file.name;

        await rpc().fs.writeFile(
            filePath,
            new Uint8Array(await file.arrayBuffer()),
            { absolutePath: true }
        );

        const ul = this.itemSelected
            ? this.itemSelected.isDirectory
                ? this.itemSelected.element.querySelector(":scope > ul")
                : this.itemSelected.element.parentElement
            : this.ulRoot;

        const updatedChildrenList = await this.openDirectory(
            parentDirectoryPathComponents
        );

        if (ul === this.ulRoot) {
            updatedChildrenList.classList.add("file-tree");
            this.ulRoot = updatedChildrenList;
        }

        ul?.replaceWith(updatedChildrenList);
    }

    private async renderActions() {
        const container = document.createElement("div");

        // const hiddenFileCheckboxLabel = document.createElement("label");
        // hiddenFileCheckboxLabel.innerText = "Hidden Files";
        // container.append(hiddenFileCheckboxLabel);

        // const hiddenFileCheckbox = document.createElement("input")
        // hiddenFileCheckbox.type = "checkbox";
        // container.appendChild(hiddenFileCheckbox);

        const newDirectoryButton = document.createElement("button");
        newDirectoryButton.classList.add("small", "text");
        newDirectoryButton.innerHTML = await (
            await fetch("/assets/icons/add-directory.svg")
        ).text();
        newDirectoryButton.addEventListener("click", (e) => {
            e.stopPropagation();
            this.mkdir();
        });
        container.append(newDirectoryButton);

        if (!this.directoryOnly) {
            const newFileButton = document.createElement("button");
            newFileButton.id = NEW_FILE_ID;
            newFileButton.classList.add("small", "text");
            newFileButton.innerHTML = await (
                await fetch("/assets/icons/add-file.svg")
            ).text();
            newFileButton.addEventListener("click", (e) => {
                e.stopPropagation();
                this.touch();
            });
            container.append(newFileButton);

            const inputFile = document.createElement("input");
            inputFile.type = "file";
            inputFile.multiple = false;
            container.append(inputFile);
            inputFile.addEventListener("click", (e) => e.stopPropagation());
            inputFile.addEventListener("change", () => {
                if (!inputFile.files?.[0]) return;

                this.addFile(inputFile.files[0]);
            });

            const uploadFileButton = document.createElement("button");
            uploadFileButton.classList.add("small", "text");
            uploadFileButton.innerHTML = await (
                await fetch("/assets/icons/download.svg")
            ).text();
            uploadFileButton.addEventListener("click", (e) => {
                e.stopPropagation();
                inputFile.click();
            });
            container.append(uploadFileButton);
        }

        return container;
    }

    async render() {
        this.itemSelected = undefined;

        const container = document.createElement("div");
        container.classList.add("file-tree-view");
        container.addEventListener("click", () => {
            if (this.itemSelected) {
                this.itemSelected.element.removeAttribute("aria-selected");
                this.itemSelected.element.classList.remove("selected");
            }

            this.itemSelected = undefined;

            if (this.onItemSelect) this.onItemSelect(this.itemSelected);
        });

        // make sure dir exists
        await rpc().fs.mkdir(this.baseDirectory.join("/"), { absolutePath: true });

        this.ulRoot = await this.openDirectory(this.baseDirectory);
        this.ulRoot.classList.add("file-tree");

        if (!this.noNewItems) {
            const actionsContainer = await this.renderActions();
            container.append(actionsContainer);
        }

        container.append(this.ulRoot);

        return container;
    }
}
