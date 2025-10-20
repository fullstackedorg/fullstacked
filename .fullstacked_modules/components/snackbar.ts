/* 
This file must follow the figma design
https://www.figma.com/design/xb3JBRCvEWpbwGda03T5QQ/Mockups?node-id=415-3655
*/

import type { Button } from "@fullstacked/ui";

type SnackBarOpt = {
    message: string;
    autoDismissTimeout?: number;
    button?: ReturnType<typeof Button>;
};

let snackBarsContainer: HTMLDivElement;

export function SnackBar(opts: SnackBarOpt) {
    if (!snackBarsContainer) {
        snackBarsContainer = document.createElement("div");
        snackBarsContainer.classList.add("snack-bars-container");
        document.body.append(snackBarsContainer);
    }

    const container = document.createElement("div");
    container.classList.add("snack-bar");

    const text = document.createElement("div");
    text.innerHTML = opts.message;
    container.append(text);

    if (opts.button) {
        container.append(opts.button);
    }

    container.style.transform = "translateY(100%)";
    container.style.transition = "300ms transform";
    snackBarsContainer.append(container);
    setTimeout(() => (container.style.transform = "translateY(0%)"));

    let timeout: ReturnType<typeof setTimeout>;
    const dismiss = () => {
        clearTimeout(timeout);

        const animDuration = 500;
        container.style.transition = `${animDuration}ms opacity`;
        container.style.opacity = "0";
        setTimeout(() => {
            container.remove();
            if (snackBarsContainer?.children.length === 0) {
                snackBarsContainer.remove();
                snackBarsContainer = null;
            }
        }, animDuration);
    };

    if (opts.autoDismissTimeout) {
        setTimeout(dismiss, opts.autoDismissTimeout);
    }

    return { dismiss };
}
