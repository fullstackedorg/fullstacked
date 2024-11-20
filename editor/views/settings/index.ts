import { Button } from "../../components/primitives/button";
import { TopBar } from "../../components/top-bar";
import { ViewScrollable } from "../../components/view-scrollable";
import stackNavigation from "../../stack-navigation";
import {
    BG_COLOR,
    PACKAGES_BUTTON_ID,
    SETTINGS_VIEW_ID
} from "../../constants";
import { createRefresheable } from "../../components/refresheable";
import { ipcEditor } from "../../ipc";
import { Project } from "../project";
import { Version } from "./version";

export function Settings() {
    const { container, scrollable } = ViewScrollable();
    container.id = SETTINGS_VIEW_ID;
    container.classList.add("view");

    const topBar = TopBar({
        title: "Settings"
    });

    container.prepend(topBar);

    scrollable.append(
        Packages(),
        // Connectivity(),
        // GitAuthentications(),
        Version()
    );

    stackNavigation.navigate(container, {
        bgColor: BG_COLOR
    });
}

function Packages() {
    const packages = document.createElement("div");
    packages.classList.add("packages");

    packages.innerHTML = `
        <h2>Packages</h2>
    `;
    const packageButton = createRefresheable(PackagesButton);
    packages.append(packageButton.element);
    packageButton.refresh(packageButton.refresh);

    return packages;
}

async function PackagesButton(onFinished: () => void) {
    const packagesCount = (await ipcEditor.fs.readdir("node_modules")).length;
    const text = packagesCount + " package" + (packagesCount > 1 ? "s" : "");
    const button = Button({
        text,
        iconLeft: "Package"
    });
    button.onclick = () => {
        const view = Project({
            id: "node_modules",
            title: "Packages",
            createdDate: null
        });
        view.ondestroy = onFinished;
    };
    button.id = PACKAGES_BUTTON_ID;

    return button;
}
